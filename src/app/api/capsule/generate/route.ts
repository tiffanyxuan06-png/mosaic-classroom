import { NextRequest, NextResponse } from 'next/server';
import { callGemini, parseGeminiJSON } from '@/lib/gemini';
import type { CapsuleMode, CapsuleQuestion, CapsuleResponse } from '@/lib/capsuleHtml';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────
// CapsuleMode, CapsuleQuestion, and CapsuleResponse live in @/lib/capsuleHtml
// alongside generateCapsuleHTML — see that file's header comment for why.
// This route still returns CapsuleResponse as JSON (its long-standing
// behaviour); generateCapsuleHTML itself is not called from here — nothing
// currently wires it into a response. See the "known limitation" this
// surfaced, called out where this fix is summarised.

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

interface GeminiCapsule {
  title: string;
  introduction: string;
  questions: CapsuleQuestion[];
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
