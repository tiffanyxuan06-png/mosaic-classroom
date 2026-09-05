import { NextRequest, NextResponse } from 'next/server';
import { callGemini, parseGeminiJSON } from '@/lib/gemini';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type CapsuleMode = 'individual' | 'class_slip';

interface CapsuleBody {
  mode: CapsuleMode;
  misconceptionId: string;
  misconceptionName: string;
  wrongAnswerPattern: string;
  remediationApproach: string;
  subject: string;
  topic: string;
  questionCount: number;
  studentName?: string;
}

interface CapsuleQuestion {
  questionId: string;
  questionText: string;
  visualScaffold: string | null;
  options: { A: string; B: string; C: string; D: string };
  correctOption: 'A' | 'B' | 'C' | 'D';
  explanation: string;
}

interface GeminiCapsule {
  title: string;
  introduction: string;
  questions: CapsuleQuestion[];
}

export interface CapsuleResponse {
  title: string;
  introduction: string;
  questions: CapsuleQuestion[];
  mode: CapsuleMode;
  misconceptionId: string;
  generatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

function isValidQuestion(q: unknown): q is CapsuleQuestion {
  if (!q || typeof q !== 'object') return false;
  const o = q as Record<string, unknown>;

  return (
    typeof o.questionId === 'string' &&
    typeof o.questionText === 'string' &&
    (o.visualScaffold === null || typeof o.visualScaffold === 'string') &&
    typeof o.options === 'object' &&
    o.options !== null &&
    ['A', 'B', 'C', 'D'].every(
      (k) => typeof (o.options as Record<string, unknown>)[k] === 'string',
    ) &&
    ['A', 'B', 'C', 'D'].includes(o.correctOption as string) &&
    typeof o.explanation === 'string'
  );
}

function isValidCapsule(c: unknown): c is GeminiCapsule {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;

  return (
    typeof o.title === 'string' &&
    typeof o.introduction === 'string' &&
    Array.isArray(o.questions) &&
    (o.questions as unknown[]).length > 0 &&
    (o.questions as unknown[]).every(isValidQuestion)
  );
}

function isValidBody(body: unknown): body is CapsuleBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;

  return (
    ['individual', 'class_slip'].includes(b.mode as string) &&
    typeof b.misconceptionId === 'string' &&
    b.misconceptionId.length > 0 &&
    typeof b.misconceptionName === 'string' &&
    b.misconceptionName.length > 0 &&
    typeof b.wrongAnswerPattern === 'string' &&
    typeof b.remediationApproach === 'string' &&
    typeof b.subject === 'string' &&
    b.subject.length > 0 &&
    typeof b.topic === 'string' &&
    b.topic.length > 0 &&
    typeof b.questionCount === 'number' &&
    b.questionCount > 0 &&
    (b.studentName === undefined || typeof b.studentName === 'string')
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────────────────────────────────────

function buildPrompt(body: CapsuleBody): string {
  return `You are a remediation content creator for Mosaic Classroom.

Generate targeted practice for students with this misconception:
- ID: ${body.misconceptionId}
- Name: ${body.misconceptionName}
- Wrong pattern: ${body.wrongAnswerPattern}
- Remediation: ${body.remediationApproach}
- Subject: ${body.subject}, Topic: ${body.topic}
- Questions needed: ${body.questionCount}
- Mode: ${body.mode}

Requirements:
- Questions must specifically target and correct this misconception
- Wrong answer options must represent the target misconception pattern
- Include a visualScaffold description where helpful (e.g. 'Draw a number line showing...')
- Include a plain-language explanation after each question
- If mode='class_slip': make questions printable-friendly with clear visual layout descriptions

Return ONLY valid JSON:
{
  "title": "...",
  "introduction": "...",
  "questions": [
    {
      "questionId": "q1",
      "questionText": "...",
      "visualScaffold": "...or null",
      "options": { "A": "", "B": "", "C": "", "D": "" },
      "correctOption": "A|B|C|D",
      "explanation": "..."
    }
  ]
}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Fallback capsule
// ────────────────────────────────────────────────────────────────────────────

function buildFallbackCapsule(body: CapsuleBody): GeminiCapsule {
  const questions: CapsuleQuestion[] = Array.from(
    { length: Math.min(body.questionCount, 3) },
    (_, i) => ({
      questionId: `fallback_q${i + 1}`,
      questionText: `Practice question ${i + 1}: Review the concept of "${body.misconceptionName}" in ${body.topic}.`,
      visualScaffold: null,
      options: {
        A: 'Work through the steps carefully',
        B: 'Skip to the answer',
        C: 'Guess without checking',
        D: 'Use an incorrect shortcut',
      },
      correctOption: 'A' as const,
      explanation: `The correct approach for "${body.misconceptionName}" is to work through each step methodically. ${body.remediationApproach}`,
    }),
  );

  return {
    title: `Practice: ${body.misconceptionName}`,
    introduction: `This set of questions helps you practise and correct a common misunderstanding in ${body.topic}. Read each question carefully before choosing your answer.`,
    questions,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HTML generator helper — self-contained, print-optimised
// ────────────────────────────────────────────────────────────────────────────

/** Escape a string for safe insertion into HTML. */
function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate a complete, self-contained HTML string for a remediation capsule.
 *
 * - Print-optimised: white background, clear typography, page-break hints
 * - Includes a `#qr-code` placeholder div for the sync link QR code
 * - Answer bubbles (○ A–D) give students a pen-friendly response area
 *
 * @param capsuleData - The CapsuleResponse returned by this route
 * @param studentName - Optional student name to render in the header
 */
export function generateCapsuleHTML(
  capsuleData: CapsuleResponse,
  studentName?: string,
): string {
  const displayName = studentName ?? capsuleData.mode === 'class_slip' ? 'Class Practice Slip' : 'Student';
  const date = new Date(capsuleData.generatedAt).toLocaleDateString('en-MY', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const questionsHTML = capsuleData.questions
    .map((q, idx) => {
      const optionRows = (['A', 'B', 'C', 'D'] as const)
        .map(
          (letter) => `
          <tr>
            <td class="bubble-cell">
              <span class="bubble" aria-label="Option ${letter}">○</span>
              <span class="option-label">${esc(letter)}</span>
            </td>
            <td class="option-text">${esc(q.options[letter])}</td>
          </tr>`,
        )
        .join('');

      const scaffoldHTML = q.visualScaffold
        ? `<div class="scaffold">
             <span class="scaffold-label">📐 Visual guide:</span>
             <p>${esc(q.visualScaffold)}</p>
           </div>`
        : '';

      return `
      <div class="question-block" id="question-${esc(q.questionId)}">
        <p class="question-number">Question ${idx + 1}</p>
        <p class="question-text">${esc(q.questionText)}</p>
        ${scaffoldHTML}
        <table class="options-table">
          <tbody>
            ${optionRows}
          </tbody>
        </table>
        <details class="explanation">
          <summary>Show explanation</summary>
          <p>${esc(q.explanation)}</p>
        </details>
      </div>`;
    })
    .join('<hr class="question-divider">');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(capsuleData.title)}</title>
  <style>
    /* ── Reset & base ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      font-size: 13pt;
      color: #111;
      background: #fff;
      padding: 2cm 2.5cm;
      max-width: 21cm;
      margin: 0 auto;
    }

    /* ── Header ── */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #111;
      padding-bottom: 12px;
      margin-bottom: 20px;
    }
    .header-left h1 {
      font-size: 17pt;
      font-weight: 700;
      line-height: 1.2;
    }
    .header-left .subtitle {
      font-size: 10pt;
      color: #555;
      margin-top: 4px;
    }
    .header-right {
      text-align: right;
      font-size: 10pt;
      color: #444;
      line-height: 1.6;
    }

    /* ── Student block ── */
    .student-block {
      display: flex;
      gap: 32px;
      margin-bottom: 18px;
      font-size: 11pt;
    }
    .student-field {
      flex: 1;
      border-bottom: 1px solid #999;
      padding-bottom: 2px;
    }
    .student-field label {
      font-size: 9pt;
      color: #777;
      display: block;
      margin-bottom: 6px;
    }

    /* ── Introduction ── */
    .introduction {
      background: #f5f5f5;
      border-left: 4px solid #333;
      padding: 10px 14px;
      font-size: 11pt;
      line-height: 1.5;
      margin-bottom: 24px;
      border-radius: 0 4px 4px 0;
    }

    /* ── Questions ── */
    .question-block {
      margin-bottom: 24px;
      page-break-inside: avoid;
    }
    .question-number {
      font-size: 9pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #555;
      margin-bottom: 4px;
    }
    .question-text {
      font-size: 13pt;
      font-weight: 600;
      line-height: 1.45;
      margin-bottom: 12px;
    }

    /* ── Visual scaffold ── */
    .scaffold {
      background: #fafafa;
      border: 1px dashed #bbb;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 10.5pt;
      color: #444;
      line-height: 1.5;
    }
    .scaffold-label {
      font-weight: 600;
      display: block;
      margin-bottom: 4px;
    }

    /* ── Options table ── */
    .options-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 10px;
    }
    .options-table tr { vertical-align: top; }
    .options-table tr + tr td { padding-top: 8px; }
    .bubble-cell {
      width: 52px;
      white-space: nowrap;
      padding-right: 8px;
    }
    .bubble {
      font-size: 16pt;
      line-height: 1;
      color: #333;
    }
    .option-label {
      font-weight: 700;
      font-size: 11pt;
      margin-left: 4px;
    }
    .option-text {
      font-size: 12pt;
      line-height: 1.4;
    }

    /* ── Explanation (print: hidden by default) ── */
    .explanation {
      margin-top: 10px;
      font-size: 10.5pt;
      color: #444;
    }
    .explanation summary {
      cursor: pointer;
      font-weight: 600;
      color: #333;
      list-style: none;
      user-select: none;
    }
    .explanation summary::before { content: '▶ '; }
    .explanation[open] summary::before { content: '▼ '; }
    .explanation p { margin-top: 6px; line-height: 1.5; padding-left: 16px; }

    /* ── Dividers ── */
    .question-divider {
      border: none;
      border-top: 1px solid #ddd;
      margin: 20px 0;
    }

    /* ── QR code placeholder ── */
    .qr-section {
      display: flex;
      align-items: center;
      gap: 20px;
      border-top: 2px solid #111;
      padding-top: 16px;
      margin-top: 32px;
    }
    #qr-code {
      width: 80px;
      height: 80px;
      border: 1px dashed #999;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 8pt;
      color: #bbb;
      text-align: center;
      flex-shrink: 0;
      border-radius: 4px;
    }
    .qr-label {
      font-size: 10pt;
      color: #444;
      line-height: 1.5;
    }
    .qr-label strong {
      display: block;
      font-size: 11pt;
      color: #111;
      margin-bottom: 2px;
    }

    /* ── Print overrides ── */
    @media print {
      body { padding: 1.5cm 2cm; }
      .explanation { display: none; }   /* hide toggle on paper */
      @page { margin: 1.5cm; }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="header">
    <div class="header-left">
      <h1>${esc(capsuleData.title)}</h1>
      <p class="subtitle">
        Mosaic Classroom · ${esc(capsuleData.mode === 'class_slip' ? 'Class Practice Slip' : 'Individual Remediation')}
      </p>
    </div>
    <div class="header-right">
      <div>${esc(date)}</div>
      <div>Misconception: <strong>${esc(capsuleData.misconceptionId)}</strong></div>
    </div>
  </header>

  <!-- Student name + date fields -->
  <div class="student-block">
    <div class="student-field">
      <label>Name</label>
      ${esc(studentName ?? '')}
    </div>
    <div class="student-field">
      <label>Class</label>
    </div>
    <div class="student-field">
      <label>Date</label>
    </div>
  </div>

  <!-- Introduction -->
  <div class="introduction">${esc(capsuleData.introduction)}</div>

  <!-- Questions -->
  <main>
    ${questionsHTML}
  </main>

  <!-- QR code sync link placeholder -->
  <footer class="qr-section">
    <div id="qr-code" aria-label="QR code placeholder">
      QR<br>code
    </div>
    <div class="qr-label">
      <strong>Scan to submit your answers</strong>
      Use the Mosaic Classroom app to sync your responses and get instant
      feedback on your misconception.
    </div>
  </footer>

</body>
</html>`;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/capsule/generate
// ────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // 1 — Parse & validate
    const body: unknown = await request.json();

    if (!isValidBody(body)) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          details:
            'Required: mode (individual|class_slip), misconceptionId, misconceptionName, wrongAnswerPattern, remediationApproach, subject, topic, questionCount (number > 0). studentName is optional.',
        },
        { status: 400 },
      );
    }

    // Apply default questionCount per mode spec if not explicitly set
    const questionCount =
      body.questionCount ?? (body.mode === 'class_slip' ? 3 : 5);

    const resolvedBody: CapsuleBody = { ...body, questionCount };

    // 2 — Build prompt & call Gemini
    const prompt = buildPrompt(resolvedBody);

    console.log('[capsule/generate] Calling Gemini for', {
      mode: body.mode,
      misconceptionId: body.misconceptionId,
      questionCount,
    });

    const raw = await callGemini(prompt, undefined, {
      system:
        'You are a remediation content creator. Respond ONLY with the JSON object requested. No extra text, no markdown.',
    });

    // 3 — Parse & validate Gemini response
    const parsed = parseGeminiJSON<GeminiCapsule>(raw);

    let capsule: GeminiCapsule;

    if (parsed && isValidCapsule(parsed)) {
      capsule = parsed;
      console.log(
        '[capsule/generate] ✅ Generated',
        capsule.questions.length,
        'questions for',
        body.misconceptionId,
      );
    } else {
      console.warn(
        '[capsule/generate] ⚠️ Gemini returned invalid capsule, using fallback.',
        { raw },
      );
      capsule = buildFallbackCapsule(resolvedBody);
    }

    // 4 — Assemble and return response
    const response: CapsuleResponse = {
      title: capsule.title,
      introduction: capsule.introduction,
      questions: capsule.questions,
      mode: body.mode,
      misconceptionId: body.misconceptionId,
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[capsule/generate] ❌ Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 },
    );
  }
}
