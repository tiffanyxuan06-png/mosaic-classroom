import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, requireSupabaseAdmin } from '@/lib/supabase-admin';
import { callGemini, parseGeminiJSON } from '@/lib/gemini';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

export const runtime = 'nodejs';
export const maxDuration = 60;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface PulseCreateBody {
  classId: string;
  teacherUid: string;
  topicOverride?: string;
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
// Validation
// ────────────────────────────────────────────────────────────────────────────

function isValidBody(body: unknown): body is PulseCreateBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.classId === 'string' &&
    b.classId.length > 0 &&
    typeof b.teacherUid === 'string' &&
    b.teacherUid.length > 0 &&
    (b.topicOverride === undefined || typeof b.topicOverride === 'string')
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
    ['A', 'B', 'C', 'D'].includes(o.correctOption as string)
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Find the top misconception across all students in the class
// ────────────────────────────────────────────────────────────────────────────

interface TopMisconception {
  misconceptionId: string;
  topic: string;
  studentCount: number;
  maxPersistence: number;
}

async function findTopMisconception(
  classId: string,
  topicOverride?: string,
): Promise<TopMisconception | null> {
  const { data: rows, error } = await supabaseAdmin
    .from('student_progress')
    .select('*')
    .eq('class_id', classId);

  if (error) {
    console.error('[pulse/create] Failed to fetch student_progress:', error);
    return null;
  }

  if (!rows || rows.length === 0) return null;

  // Tally misconceptions across all students
  const tally = new Map<
    string,
    { topic: string; count: number; maxPersistence: number }
  >();

  for (const row of rows) {
    const topic = row.topic as string | undefined;
    const misconceptions = Array.isArray(row.active_misconceptions)
      ? row.active_misconceptions
      : [];

    for (const m of misconceptions) {
      if (m.isCleared) continue;
      if (topicOverride && topic !== topicOverride) continue;

      const key = m.misconceptionId as string;
      const existing = tally.get(key);
      if (existing) {
        existing.count += 1;
        existing.maxPersistence = Math.max(
          existing.maxPersistence,
          m.persistenceScore ?? 0,
        );
      } else {
        tally.set(key, {
          topic: topic ?? 'unknown',
          count: 1,
          maxPersistence: m.persistenceScore ?? 0,
        });
      }
    }
  }

  if (tally.size === 0) return null;

  // Pick the misconception affecting the most students, break ties by persistence
  let best: TopMisconception | null = null;
  for (const [misconceptionId, info] of tally) {
    if (
      !best ||
      info.count > best.studentCount ||
      (info.count === best.studentCount &&
        info.maxPersistence > best.maxPersistence)
    ) {
      best = {
        misconceptionId,
        topic: info.topic,
        studentCount: info.count,
        maxPersistence: info.maxPersistence,
      };
    }
  }

  return best;
}

// ────────────────────────────────────────────────────────────────────────────
// Generate a single diagnostic question
// ────────────────────────────────────────────────────────────────────────────

function buildDiagnosticPrompt(
  topic: string,
  misconceptionId: string | null,
  questionNumber: number,
  previousTexts: string[],
): string {
  const previousList =
    previousTexts.length > 0
      ? previousTexts.map((t) => `"${t}"`).join(', ')
      : 'none';

  return `You are a math question generator for Mosaic Classroom, an adaptive learning platform for Malaysian secondary schools.

Generate one diagnostic multiple-choice question (question ${questionNumber} of 3 in a Pulse Check):
- Subject: mathematics
- Topic: ${topic}
- Target misconception: ${misconceptionId ?? 'general diagnostic'}
- Difficulty: 2 (medium — this is a quick class-wide check)
- Do NOT repeat these questions: ${previousList}

Rules:
- Exactly 4 answer choices (A, B, C, D)
- One correct answer
- Each wrong answer should reveal a specific misconception or error pattern
- Use Malaysian ringgit, local names, or local food in real-world contexts where possible
- Keep the question concise — students have about 60 seconds per question

Return ONLY valid JSON, no markdown, no explanation:
{
  "questionId": "pulse_q${questionNumber}_<timestamp>",
  "questionText": "...",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "correctOption": "A|B|C|D",
  "isTransferQuestion": false,
  "isResetQuestion": false
}`;
}

// Fallback questions for when Gemini is unavailable
const PULSE_FALLBACKS: GeneratedQuestion[] = [
  {
    questionId: 'pulse_fallback_1',
    questionText: 'What is 3/4 + 1/6?',
    options: { A: '11/12', B: '4/10', C: '4/6', D: '3/24' },
    correctOption: 'A',
    isTransferQuestion: false,
    isResetQuestion: false,
  },
  {
    questionId: 'pulse_fallback_2',
    questionText:
      'Aisyah has 0.75 litres of water. She pours out 0.3 litres. How much is left?',
    options: { A: '0.45 litres', B: '0.72 litres', C: '0.45 litres', D: '0.105 litres' },
    correctOption: 'A',
    isTransferQuestion: false,
    isResetQuestion: false,
  },
  {
    questionId: 'pulse_fallback_3',
    questionText: 'What is 25% of 80?',
    options: { A: '20', B: '25', C: '40', D: '2000' },
    correctOption: 'A',
    isTransferQuestion: false,
    isResetQuestion: false,
  },
];

async function generateDiagnosticQuestion(
  topic: string,
  misconceptionId: string | null,
  questionNumber: number,
  previousTexts: string[],
): Promise<GeneratedQuestion> {
  try {
    const prompt = buildDiagnosticPrompt(
      topic,
      misconceptionId,
      questionNumber,
      previousTexts,
    );

    const raw = await callGemini(prompt, undefined, {
      system:
        'You are a quiz-question generator. Respond ONLY with the JSON object requested. No extra text.',
    });

    const parsed = parseGeminiJSON<GeneratedQuestion>(raw);

    if (parsed && isValidQuestion(parsed)) {
      return {
        ...parsed,
        questionId: parsed.questionId || `pulse_q${questionNumber}_${Date.now()}`,
      };
    }
  } catch (error) {
    console.error(`[pulse/create] Question ${questionNumber} generation failed:`, error);
  }

  // Fallback
  const fallback = PULSE_FALLBACKS[questionNumber - 1] ?? PULSE_FALLBACKS[0];
  return { ...fallback, questionId: `pulse_q${questionNumber}_${Date.now()}_fallback` };
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/pulse/create
// ────────────────────────────────────────────────────────────────────────────

const PULSE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(request: NextRequest) {
  const notConfigured = requireSupabaseAdmin();
  if (notConfigured) return notConfigured;

  try {
    // 1 — Parse & validate
    const body: unknown = await request.json();

    if (!isValidBody(body)) {
      return NextResponse.json(
        {
          error: 'Invalid request body',
          details: 'Required: classId (string), teacherUid (string). Optional: topicOverride (string).',
        },
        { status: 400 },
      );
    }

    console.log('[pulse/create] Creating pulse for class', body.classId);

    // 2 — Expire any existing active pulses for this class
    const { data: expiredPulses, error: expireError } = await supabaseAdmin
      .from('pulses')
      .update({ status: 'expired' })
      .eq('class_id', body.classId)
      .eq('status', 'active')
      .select('id');

    if (expireError) {
      console.error('[pulse/create] Failed to expire previous pulses:', expireError);
    } else if (expiredPulses && expiredPulses.length > 0) {
      console.log(`[pulse/create] Expired ${expiredPulses.length} previous active pulse(s)`);
    }

    // 3 — Find the top misconception
    const topMisconception = await findTopMisconception(
      body.classId,
      body.topicOverride,
    );

    const targetTopic = body.topicOverride ?? topMisconception?.topic ?? 'fractions';
    const targetMisconceptionId = topMisconception?.misconceptionId ?? null;

    console.log('[pulse/create] Target:', {
      topic: targetTopic,
      misconception: targetMisconceptionId,
      affectedStudents: topMisconception?.studentCount ?? 0,
    });

    // 4 — Generate 3 diagnostic questions (sequentially to avoid prompt collisions)
    const questions: GeneratedQuestion[] = [];
    const previousTexts: string[] = [];

    for (let i = 1; i <= 3; i++) {
      const q = await generateDiagnosticQuestion(
        targetTopic,
        targetMisconceptionId,
        i,
        previousTexts,
      );
      questions.push(q);
      previousTexts.push(q.questionText);
    }

    // 5 — Write the pulse document
    const now = Date.now();
    const pulseId = `pulse_${body.classId}_${now}`;

    const targetMisconception = topMisconception
      ? {
          misconceptionId: topMisconception.misconceptionId,
          topic: topMisconception.topic,
          studentCount: topMisconception.studentCount,
        }
      : null;

    const { error: insertError } = await supabaseAdmin.from('pulses').insert({
      id: pulseId,
      class_id: body.classId,
      teacher_uid: body.teacherUid,
      questions,
      target_misconception: targetMisconception,
      status: 'active',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + PULSE_TTL_MS).toISOString(),
    });

    if (insertError) {
      throw insertError;
    }

    console.log('[pulse/create] ✅ Pulse created:', pulseId);

    return NextResponse.json({ pulseId, questions });
  } catch (error) {
    console.error('[pulse/create] ❌ Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 },
    );
  }
}
