import { NextRequest, NextResponse } from 'next/server';
import { callGemini, parseGeminiJSON } from '@/lib/gemini';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface QuizGenerateBody {
  subject: string;
  topic: string;
  difficulty: 1 | 2 | 3;
  activeMisconceptionId: string | null;
  activeMisconceptionDescription: string | null;
  previousQuestionTexts: string[];
  isTransferQuestion: boolean;
  isResetQuestion: boolean;
}

interface GeneratedQuestion {
  questionId: string;
  questionText: string;
  options: { A: string; B: string; C: string; D: string };
  correctOption: 'A' | 'B' | 'C' | 'D';
  isTransferQuestion: boolean;
  isResetQuestion: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Fallback questions — used when Gemini is unavailable or returns bad JSON
// ────────────────────────────────────────────────────────────────────────────

const FALLBACK_QUESTIONS: Record<string, GeneratedQuestion[]> = {
  'Algebra': [
    {
      questionId: 'fallback_algebra_1',
      questionText:
        'Siti buys 3 packets of nasi lemak at RM2.50 each and pays with a RM10 note. Which expression represents her change?',
      options: {
        A: '10 − 3 × 2.50',
        B: '3 × 2.50 − 10',
        C: '10 ÷ (3 × 2.50)',
        D: '10 − 2.50',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
    {
      questionId: 'fallback_algebra_2',
      questionText: 'Solve for x: 2x + 5 = 13',
      options: {
        A: 'x = 4',
        B: 'x = 9',
        C: 'x = 6',
        D: 'x = 3',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
    {
      questionId: 'fallback_algebra_3',
      questionText:
        'Ahmad has x ringgit. After receiving RM15 from his mother, he now has RM42. Which equation represents this situation?',
      options: {
        A: 'x + 15 = 42',
        B: 'x − 15 = 42',
        C: '15x = 42',
        D: 'x + 42 = 15',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
  ],
  'Fractions': [
    {
      questionId: 'fallback_fractions_1',
      questionText: 'What is 1/2 + 1/3?',
      options: {
        A: '5/6',
        B: '2/5',
        C: '1/5',
        D: '2/6',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
    {
      questionId: 'fallback_fractions_2',
      questionText:
        'Mei Ling ate 2/5 of a kuih lapis. What fraction is left?',
      options: {
        A: '3/5',
        B: '2/5',
        C: '1/5',
        D: '5/2',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
    {
      questionId: 'fallback_fractions_3',
      questionText: 'Simplify the fraction 12/18.',
      options: {
        A: '2/3',
        B: '3/4',
        C: '6/9',
        D: '4/6',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
  ],
  'Geometry': [
    {
      questionId: 'fallback_geometry_1',
      questionText:
        'A rectangular padang at a Malaysian school measures 30m by 20m. What is its area?',
      options: {
        A: '600 m²',
        B: '100 m²',
        C: '50 m²',
        D: '120 m²',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
    {
      questionId: 'fallback_geometry_2',
      questionText:
        'What is the sum of interior angles of a triangle?',
      options: {
        A: '180°',
        B: '360°',
        C: '90°',
        D: '270°',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
  ],
  // Generic fallback for any topic not listed above
  '_default': [
    {
      questionId: 'fallback_default_1',
      questionText: 'What is the value of 15 × 4?',
      options: {
        A: '60',
        B: '45',
        C: '54',
        D: '64',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
    {
      questionId: 'fallback_default_2',
      questionText:
        'Encik Razak buys 5 kg of rice at RM3.20 per kg. What is the total cost?',
      options: {
        A: 'RM16.00',
        B: 'RM15.00',
        C: 'RM8.20',
        D: 'RM32.00',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
    {
      questionId: 'fallback_default_3',
      questionText: 'What is the value of 144 ÷ 12?',
      options: {
        A: '12',
        B: '11',
        C: '13',
        D: '14',
      },
      correctOption: 'A',
      isTransferQuestion: false,
      isResetQuestion: false,
    },
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function pickFallback(topic: string): GeneratedQuestion {
  const pool =
    FALLBACK_QUESTIONS[topic] ?? FALLBACK_QUESTIONS['_default'];
  const question = pool[Math.floor(Math.random() * pool.length)];
  // Stamp a unique-ish ID so repeated fallbacks look distinct in the UI
  return { ...question, questionId: `q_${Date.now()}_fallback` };
}

function isValidBody(body: unknown): body is QuizGenerateBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;

  return (
    typeof b.subject === 'string' &&
    typeof b.topic === 'string' &&
    [1, 2, 3].includes(b.difficulty as number) &&
    (b.activeMisconceptionId === null ||
      typeof b.activeMisconceptionId === 'string') &&
    (b.activeMisconceptionDescription === null ||
      typeof b.activeMisconceptionDescription === 'string') &&
    Array.isArray(b.previousQuestionTexts) &&
    typeof b.isTransferQuestion === 'boolean' &&
    typeof b.isResetQuestion === 'boolean'
  );
}

function isValidQuestion(q: unknown): q is GeneratedQuestion {
  if (!q || typeof q !== 'object') return false;
  const o = q as Record<string, unknown>;

  return (
    typeof o.questionId === 'string' &&
    typeof o.questionText === 'string' &&
    typeof o.options === 'object' &&
    o.options !== null &&
    ['A', 'B', 'C', 'D'].every(
      (k) => typeof (o.options as Record<string, unknown>)[k] === 'string',
    ) &&
    ['A', 'B', 'C', 'D'].includes(o.correctOption as string) &&
    typeof o.isTransferQuestion === 'boolean' &&
    typeof o.isResetQuestion === 'boolean'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────────────────────────────────────

function buildPrompt(body: QuizGenerateBody): string {
  const {
    subject,
    topic,
    difficulty,
    activeMisconceptionId,
    activeMisconceptionDescription,
    previousQuestionTexts,
    isTransferQuestion,
    isResetQuestion,
  } = body;

  const previousList =
    previousQuestionTexts.length > 0
      ? previousQuestionTexts.map((t) => `"${t}"`).join(', ')
      : 'none';

  return `You are a math question generator for Mosaic Classroom, an adaptive learning platform for Malaysian secondary schools.

Generate one multiple-choice question for:
- Subject: ${subject}
- Topic: ${topic}
- Difficulty: ${difficulty} (1=easy, 2=medium, 3=hard)
- Target misconception: ${activeMisconceptionId ?? 'none'} — ${activeMisconceptionDescription ?? 'none'}
- Is transfer question: ${isTransferQuestion}
- Is confidence reset: ${isResetQuestion}
- Do NOT repeat these questions: ${previousList}

Rules:
- Exactly 4 answer choices (A, B, C, D)
- One correct answer
- Each wrong answer must represent a specific, documentable misconception or error pattern
- Use Malaysian ringgit, local names, or local food in real-world contexts where possible
- If isTransferQuestion=true: use a completely different real-world framing of the same concept
- If isResetQuestion=true: generate an easy question on a different topic that most students can answer correctly

Return ONLY valid JSON, no markdown, no explanation:
{
  "questionId": "q_<timestamp>",
  "questionText": "...",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "correctOption": "A|B|C|D",
  "isTransferQuestion": ${isTransferQuestion},
  "isResetQuestion": ${isResetQuestion}
}`;
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/quiz/generate
// ────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // 1 — Parse & validate request body
    const body: unknown = await request.json();

    if (!isValidBody(body)) {
      return NextResponse.json(
        { error: 'Invalid request body', details: 'See API docs for expected shape.' },
        { status: 400 },
      );
    }

    // 2 — Build prompt & call Gemini
    const prompt = buildPrompt(body);

    console.log('[quiz/generate] Calling Gemini for', {
      topic: body.topic,
      difficulty: body.difficulty,
      misconception: body.activeMisconceptionId,
      isTransfer: body.isTransferQuestion,
      isReset: body.isResetQuestion,
    });

    const raw = await callGemini(prompt, undefined, {
      system:
        'You are a quiz-question generator. Respond ONLY with the JSON object requested. No extra text.',
    });

    // 3 — Parse & validate Gemini response
    const parsed = parseGeminiJSON<GeneratedQuestion>(raw);

    if (parsed && isValidQuestion(parsed)) {
      // Ensure the id is always unique
      const question: GeneratedQuestion = {
        ...parsed,
        questionId: parsed.questionId || `q_${Date.now()}`,
      };

      console.log('[quiz/generate] ✅ Generated question:', question.questionId);
      return NextResponse.json(question);
    }

    // 4 — Gemini returned unparseable / invalid shape → fallback
    console.warn(
      '[quiz/generate] ⚠️ Gemini returned invalid JSON, using fallback.',
      { raw },
    );

    return NextResponse.json(pickFallback(body.topic));
  } catch (error) {
    console.error('[quiz/generate] ❌ Unexpected error:', error);

    // Best-effort fallback — if we can still extract the topic from the
    // request, scope the fallback to it; otherwise use _default.
    let topic = '_default';
    try {
      const retryBody = await request.clone().json();
      if (typeof retryBody?.topic === 'string') topic = retryBody.topic;
    } catch {
      // body already consumed — use _default
    }

    return NextResponse.json(pickFallback(topic));
  }
}
