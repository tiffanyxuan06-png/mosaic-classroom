import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, requireSupabaseAdmin } from '@/lib/supabase-admin';
import { callGemini, parseGeminiJSON } from '@/lib/gemini';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface ClassifyBody {
  questionText: string;
  correctAnswer: string;
  studentAnswer: string;
  subject: string;
  topic: string;
}

/** Simplified shape passed to the Gemini prompt. */
interface MisconceptionEntry {
  misconceptionId: string;
  name: string;
  wrong_answer_pattern: string;
}

interface ClassificationResult {
  misconceptionId: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

function isValidBody(body: unknown): body is ClassifyBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;

  return (
    typeof b.questionText === 'string' &&
    b.questionText.length > 0 &&
    typeof b.correctAnswer === 'string' &&
    b.correctAnswer.length > 0 &&
    typeof b.studentAnswer === 'string' &&
    b.studentAnswer.length > 0 &&
    typeof b.subject === 'string' &&
    b.subject.length > 0 &&
    typeof b.topic === 'string' &&
    b.topic.length > 0
  );
}

function isValidClassification(
  result: unknown,
  validIds: Set<string>,
): result is ClassificationResult {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;

  return (
    typeof r.misconceptionId === 'string' &&
    validIds.has(r.misconceptionId) &&
    ['high', 'medium', 'low'].includes(r.confidence as string) &&
    typeof r.reasoning === 'string'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Supabase helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all misconception rows that match the given subject + topic.
 *
 * Table: `misconceptions`
 * Expected columns (at minimum):
 *   - id: text (misconception identifier)
 *   - name: text
 *   - wrong_answer_pattern: text
 *   - subject: text
 *   - topic: text
 */
async function fetchMisconceptionLibrary(
  subject: string,
  topic: string,
): Promise<MisconceptionEntry[]> {
  const { data, error } = await supabaseAdmin
    .from('misconceptions')
    .select('*')
    .eq('subject', subject)
    .eq('topic', topic);

  if (error) {
    console.error('[quiz/classify] Failed to fetch misconceptions:', error);
    return [];
  }

  if (!data || data.length === 0) {
    console.warn(
      `[quiz/classify] No misconceptions found for subject="${subject}", topic="${topic}"`,
    );
    return [];
  }

  return data.map((row) => ({
    misconceptionId: row.id,
    name: row.name ?? 'Unknown misconception',
    wrong_answer_pattern: row.wrong_answer_pattern ?? '',
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────────────────────────────────────

function buildPrompt(
  body: ClassifyBody,
  library: MisconceptionEntry[],
): string {
  const misconceptionLibraryJSON = JSON.stringify(library, null, 2);

  return `You are a misconception classifier for Mosaic Classroom.

A student answered incorrectly. Classify their specific misconception.

Question: ${body.questionText}
Correct answer: ${body.correctAnswer}
Student selected: ${body.studentAnswer}
Subject: ${body.subject}
Topic: ${body.topic}

Available misconceptions (return ONLY one of these IDs):
${misconceptionLibraryJSON}

Rules:
- Return ONLY a misconceptionId from the list above
- Choose the closest match if no exact match exists
- Never invent a new ID
- Never return null or 'unknown'

Return ONLY valid JSON, no markdown:
{
  "misconceptionId": "exact_id_from_library",
  "confidence": "high|medium|low",
  "reasoning": "one sentence"
}`;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/quiz/classify
// ────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const notConfigured = requireSupabaseAdmin();
  if (notConfigured) return notConfigured;

  try {
    // 1 — Parse & validate request body
    const body: unknown = await request.json();

    if (!isValidBody(body)) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          details:
            'Required fields: questionText, correctAnswer, studentAnswer, subject, topic (all non-empty strings).',
        },
        { status: 400 },
      );
    }

    // 2 — Fetch misconception library from Firestore
    const library = await fetchMisconceptionLibrary(body.subject, body.topic);

    if (library.length === 0) {
      return NextResponse.json(
        {
          error: 'No misconceptions found',
          details: `No misconception rows in Supabase for subject="${body.subject}", topic="${body.topic}". Seed the misconceptions table first.`,
        },
        { status: 404 },
      );
    }

    const validIds = new Set(library.map((m) => m.misconceptionId));

    // 3 — Build prompt & call Gemini
    const prompt = buildPrompt(body, library);

    console.log('[quiz/classify] Calling Gemini for', {
      subject: body.subject,
      topic: body.topic,
      studentAnswer: body.studentAnswer,
      librarySize: library.length,
    });

    const raw = await callGemini(prompt, undefined, {
      system:
        'You are a misconception classifier. Respond ONLY with the JSON object requested. No extra text.',
    });

    // 4 — Parse & validate Gemini response
    const parsed = parseGeminiJSON<ClassificationResult>(raw);

    if (parsed && isValidClassification(parsed, validIds)) {
      console.log(
        '[quiz/classify] ✅ Classified:',
        parsed.misconceptionId,
        `(${parsed.confidence})`,
      );
      return NextResponse.json(parsed);
    }

    // 5 — Invalid ID or unparseable → check if the returned ID is at least
    //     a string that exists in the library; otherwise fallback.
    //     Cast to Record to avoid TS narrowing `parsed` to `never` after the
    //     type-guard above already covered the ClassificationResult branch.
    const partial = parsed as Record<string, unknown> | null;

    if (
      partial &&
      typeof partial.misconceptionId === 'string' &&
      validIds.has(partial.misconceptionId)
    ) {
      // Shape was slightly off but the ID is valid — salvage it
      const salvaged: ClassificationResult = {
        misconceptionId: partial.misconceptionId,
        confidence:
          typeof partial.confidence === 'string' &&
          ['high', 'medium', 'low'].includes(partial.confidence)
            ? (partial.confidence as 'high' | 'medium' | 'low')
            : 'low',
        reasoning:
          typeof partial.reasoning === 'string'
            ? partial.reasoning
            : 'Classification recovered from partial Gemini response.',
      };

      console.log(
        '[quiz/classify] ⚠️ Salvaged partial response:',
        salvaged.misconceptionId,
      );
      return NextResponse.json(salvaged);
    }

    // 6 — Fallback: return the first misconception in the library
    console.warn(
      '[quiz/classify] ⚠️ Gemini returned invalid misconceptionId, using fallback.',
      { raw, parsed },
    );

    const fallback: ClassificationResult = {
      misconceptionId: library[0].misconceptionId,
      confidence: 'low',
      reasoning:
        'Automatic fallback — Gemini could not classify the misconception reliably.',
    };

    return NextResponse.json(fallback);
  } catch (error) {
    console.error('[quiz/classify] ❌ Unexpected error:', error);

    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 },
    );
  }
}
