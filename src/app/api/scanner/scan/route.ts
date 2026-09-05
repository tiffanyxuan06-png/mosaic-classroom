import { NextRequest, NextResponse } from 'next/server';
import { callGemini, parseGeminiJSON } from '@/lib/gemini';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

/** Firebase Admin and the AI SDK both need Node APIs, not the edge runtime. */
export const runtime = 'nodejs';

/** A page of answer slips can take Gemini a while; the default 10s is not enough. */
export const maxDuration = 60;

/** Decoded image ceiling. Gemini caps inline data well below this anyway. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = ['jpeg', 'png', 'webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const ANSWER_OPTIONS = ['A', 'B', 'C', 'D'] as const;
type AnswerOption = (typeof ANSWER_OPTIONS)[number];

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface ScanBody {
  imageBase64: string;
  imageType: ImageType;
  classId: string;
  questionLabels: string[];
}

/** One slip as returned to the client. Every requested label is always present. */
interface SlipResult {
  studentIdentifier: string;
  answers: Record<string, AnswerOption | null>;
}

interface ScanSuccess {
  results: SlipResult[];
  scannedAt: string;
  totalSlipsDetected: number;
}

interface ScanFailure {
  results: never[];
  error: 'scan_failed';
  message: string;
}

/** Shape Gemini is asked to produce, before validation. */
interface RawSlip {
  studentIdentifier?: unknown;
  answers?: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

function isValidBody(body: unknown): body is ScanBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;

  return (
    typeof b.imageBase64 === 'string' &&
    b.imageBase64.trim().length > 0 &&
    typeof b.imageType === 'string' &&
    IMAGE_TYPES.includes(b.imageType as ImageType) &&
    typeof b.classId === 'string' &&
    b.classId.trim().length > 0 &&
    Array.isArray(b.questionLabels) &&
    b.questionLabels.length > 0 &&
    b.questionLabels.every((label) => typeof label === 'string' && label.trim().length > 0)
  );
}

/**
 * The client is documented to send bare base64, but browsers hand back
 * `data:image/png;base64,...` from canvas and FileReader often enough that
 * silently tolerating the prefix is kinder than a 400.
 */
function stripDataUrlPrefix(imageBase64: string): string {
  return imageBase64.trim().replace(/^data:[^;,]+;base64,/, '');
}

function approximateByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Coerce whatever Gemini wrote into an answer option or null.
 *
 * The prompt asks for JSON null, but vision models routinely return the string
 * "null", an empty string, a dash, or a lowercase letter instead. All of those
 * mean the same thing to a teacher, so normalise rather than discard the slip.
 */
function normaliseAnswer(value: unknown): AnswerOption | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;

  const cleaned = value.trim().toUpperCase();

  if (cleaned === '' || cleaned === 'NULL' || cleaned === '-' || cleaned === 'NONE') {
    return null;
  }

  return ANSWER_OPTIONS.includes(cleaned as AnswerOption) ? (cleaned as AnswerOption) : null;
}

/**
 * Validate one slip and pin its answers to exactly the requested labels:
 * missing labels become null, invented ones are dropped. The scanner UI can
 * then render a fixed column per question without defensive checks.
 */
function validateSlip(raw: unknown, questionLabels: string[]): SlipResult | null {
  if (!raw || typeof raw !== 'object') return null;

  const slip = raw as RawSlip;

  if (typeof slip.studentIdentifier !== 'string' || slip.studentIdentifier.trim().length === 0) {
    return null;
  }

  if (!slip.answers || typeof slip.answers !== 'object' || Array.isArray(slip.answers)) {
    return null;
  }

  const rawAnswers = slip.answers as Record<string, unknown>;
  const answers: Record<string, AnswerOption | null> = {};

  for (const label of questionLabels) {
    answers[label] = normaliseAnswer(rawAnswers[label]);
  }

  return { studentIdentifier: slip.studentIdentifier.trim(), answers };
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────────────────────────────────────

function buildPrompt(questionLabels: string[]): string {
  const labelList = questionLabels.join(', ');

  // Mirror the caller's labels in the example so the model keys the object the
  // same way, rather than defaulting to Q1/Q2/Q3.
  const answersExample = questionLabels
    .map((label) => `      ${JSON.stringify(label)}: "A|B|C|D|null"`)
    .join(',\n');

  return `You are an answer sheet reader for Mosaic Classroom.

The image shows completed student answer slips from a classroom.
Each slip has a student name or ID and answer selections for: ${labelList}
Answer options are A, B, C, or D.

Instructions:
- Read each slip carefully
- Extract the student identifier (name or ID written on the slip)
- Extract their selected answer for each question
- If handwriting is unclear, make your best guess
- If a question has no answer, use null

Return ONLY valid JSON, no markdown:
[
  {
    "studentIdentifier": "...",
    "answers": {
${answersExample}
    }
  }
]`;
}

// ────────────────────────────────────────────────────────────────────────────
// Responses
// ────────────────────────────────────────────────────────────────────────────

function failure(message: string, status: number): NextResponse<ScanFailure> {
  return NextResponse.json({ results: [], error: 'scan_failed' as const, message }, { status });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/scanner/scan
// ────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse<ScanSuccess | ScanFailure>> {
  try {
    // 1 — Parse & validate the request body
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return failure('Request body is not valid JSON.', 400);
    }

    if (!isValidBody(body)) {
      return failure(
        'Required fields: imageBase64 (non-empty string), imageType (jpeg|png|webp), ' +
          'classId (non-empty string), questionLabels (non-empty array of strings).',
        400,
      );
    }

    const imageBase64 = stripDataUrlPrefix(body.imageBase64);

    if (imageBase64.length === 0) {
      return failure('imageBase64 contained a data URL prefix but no image data.', 400);
    }

    const imageBytes = approximateByteLength(imageBase64);

    if (imageBytes > MAX_IMAGE_BYTES) {
      return failure(
        `Image is roughly ${Math.round(imageBytes / 1024 / 1024)}MB, over the ` +
          `${MAX_IMAGE_BYTES / 1024 / 1024}MB limit. Capture at a lower resolution.`,
        413,
      );
    }

    const questionLabels = body.questionLabels.map((label) => label.trim());

    // 2 — Multimodal Gemini call: prompt + image, with the MIME type the client declared
    console.log('[scanner/scan] Calling Gemini Vision for', {
      classId: body.classId,
      questionLabels,
      imageType: body.imageType,
      imageKB: Math.round(imageBytes / 1024),
    });

    const raw = await callGemini(buildPrompt(questionLabels), imageBase64, {
      mediaType: `image/${body.imageType}`,
      system:
        'You are an answer sheet reader. Respond ONLY with the JSON array requested. ' +
        'No markdown fences, no commentary.',
    });

    // 3 — Parse the response
    const parsed = parseGeminiJSON<RawSlip[]>(raw);

    if (parsed === null) {
      console.error('[scanner/scan] Gemini response was not parseable JSON:', raw.slice(0, 500));
      return failure('Gemini returned a response that could not be parsed as JSON.', 502);
    }

    // callGemini swallows its own errors and hands back a fallback object, so an
    // object here means the vision call itself failed rather than the parse.
    if (!Array.isArray(parsed)) {
      const reason =
        typeof (parsed as unknown as Record<string, unknown>)?.error === 'string'
          ? 'The Gemini Vision call failed. Check GEMINI_API_KEY and the server logs.'
          : 'Gemini returned an object where an array of slips was expected.';

      console.error('[scanner/scan] Expected an array, got:', raw.slice(0, 500));
      return failure(reason, 502);
    }

    // 4 — Validate each entry
    const results: SlipResult[] = [];
    let dropped = 0;

    for (const entry of parsed) {
      const slip = validateSlip(entry, questionLabels);

      if (slip) {
        results.push(slip);
      } else {
        dropped += 1;
      }
    }

    if (dropped > 0) {
      console.warn(
        `[scanner/scan] Dropped ${dropped} of ${parsed.length} slips ` +
          'missing a studentIdentifier or answers object.',
      );
    }

    if (results.length === 0) {
      return failure(
        parsed.length === 0
          ? 'No answer slips were detected in the image. Try a clearer or closer photo.'
          : `Detected ${parsed.length} slips but none had a readable student identifier and answers.`,
        422,
      );
    }

    console.log(`[scanner/scan] Read ${results.length} slips for class ${body.classId}`);

    // 5 — Success
    return NextResponse.json({
      results,
      scannedAt: new Date().toISOString(),
      totalSlipsDetected: results.length,
    });
  } catch (error) {
    console.error('[scanner/scan] Unexpected error:', error);
    return failure(error instanceof Error ? error.message : String(error), 500);
  }
}
