import { NextRequest, NextResponse } from 'next/server';
import { callGemini, parseGeminiJSON } from '@/lib/gemini';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface MisconceptionSummary {
  misconceptionId: string;
  misconceptionName: string;
  studentCount: number;
  persistenceScore: number;
}

interface ActionCardBody {
  classId: string;
  classSize: number;
  subject: string;
  topic: string;
  topMisconceptions: MisconceptionSummary[];
}

interface MicroLesson {
  /** Total minutes the plan is designed to take (10-15). */
  durationMinutes: number;
  /** Ordered steps a teacher can run straight off the card. */
  steps: { minutes: number; instruction: string }[];
  /** The specific wrong thinking to name and confront out loud. */
  addressesMisconception: string;
  /** One question that proves whether the fix landed. */
  checkForUnderstanding: string;
}

interface ActionCard {
  urgentSummary: string;
  suggestedActivity: string | null;
  microLesson: MicroLesson | null;
  pushPulseCheck: boolean;
  affectedStudentCount: number;
}

// ────────────────────────────────────────────────────────────────────────────
// In-memory cache  (survives across requests in the same Node.js process)
// ────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  card: ActionCard;
  expiresAt: number;
}

// Module-level map — intentionally NOT using a WeakMap so entries persist
// across multiple requests in the same warm serverless instance.
const cache = new Map<string, CacheEntry>();

function getCached(classId: string): ActionCard | null {
  const entry = cache.get(classId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(classId);
    return null;
  }
  return entry.card;
}

function setCached(classId: string, card: ActionCard): void {
  cache.set(classId, { card, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

function isValidMisconception(m: unknown): m is MisconceptionSummary {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.misconceptionId === 'string' &&
    typeof o.misconceptionName === 'string' &&
    typeof o.studentCount === 'number' &&
    typeof o.persistenceScore === 'number'
  );
}

function isValidBody(body: unknown): body is ActionCardBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.classId === 'string' &&
    b.classId.length > 0 &&
    typeof b.classSize === 'number' &&
    b.classSize > 0 &&
    typeof b.subject === 'string' &&
    b.subject.length > 0 &&
    typeof b.topic === 'string' &&
    b.topic.length > 0 &&
    Array.isArray(b.topMisconceptions) &&
    (b.topMisconceptions as unknown[]).every(isValidMisconception)
  );
}

function isValidMicroLesson(lesson: unknown): lesson is MicroLesson {
  if (!lesson || typeof lesson !== 'object') return false;
  const l = lesson as Record<string, unknown>;
  return (
    typeof l.durationMinutes === 'number' &&
    typeof l.addressesMisconception === 'string' &&
    typeof l.checkForUnderstanding === 'string' &&
    Array.isArray(l.steps) &&
    l.steps.length > 0 &&
    (l.steps as unknown[]).every((step) => {
      if (!step || typeof step !== 'object') return false;
      const s = step as Record<string, unknown>;
      return typeof s.minutes === 'number' && typeof s.instruction === 'string';
    })
  );
}

function isValidActionCard(card: unknown): card is ActionCard {
  if (!card || typeof card !== 'object') return false;
  const c = card as Record<string, unknown>;
  return (
    typeof c.urgentSummary === 'string' &&
    (c.suggestedActivity === null || typeof c.suggestedActivity === 'string') &&
    (c.microLesson === null ||
      c.microLesson === undefined ||
      isValidMicroLesson(c.microLesson)) &&
    typeof c.pushPulseCheck === 'boolean' &&
    typeof c.affectedStudentCount === 'number'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Returns true if every misconception has a zero student count. */
function hasNoIssues(misconceptions: MisconceptionSummary[]): boolean {
  return (
    misconceptions.length === 0 ||
    misconceptions.every((m) => m.studentCount === 0)
  );
}

/** Total students affected across all misconceptions in the list. */
function totalAffected(misconceptions: MisconceptionSummary[]): number {
  return misconceptions.reduce((sum, m) => sum + m.studentCount, 0);
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ────────────────────────────────────────────────────────────────────────────

function buildPrompt(body: ActionCardBody): string {
  const topMisconceptionsJSON = JSON.stringify(
    body.topMisconceptions,
    null,
    2,
  );

  return `You are a teaching advisor for Mosaic Classroom. Generate a concise actionable recommendation.

Class data:
- Size: ${body.classSize} students
- Subject: ${body.subject}, Topic: ${body.topic}
- Top misconceptions detected:
${topMisconceptionsJSON}

Generate a teacher action card:
1. One urgent sentence: what is the main problem right now
2. A one-line summary of the activity to run
3. A concrete 10-15 minute micro-lesson plan broken into timed steps the
   teacher can run straight off the card, targeting the TOP misconception
   above. Name the wrong thinking explicitly so the teacher can confront it
   out loud, and end with one question that proves whether the fix landed.
4. Whether to push a 3-question Pulse Check after (true/false)

Rules for the micro-lesson:
- Steps must sum to durationMinutes, which must be between 10 and 15
- 3 to 5 steps, each one concrete instruction (not "discuss the topic")
- Target the specific error pattern, not the general topic
- Name materials or board work where relevant

Keep language simple — the teacher is mid-lesson. One decision, not a report.

Return ONLY valid JSON:
{
  "urgentSummary": "...",
  "suggestedActivity": "...",
  "microLesson": {
    "durationMinutes": number,
    "steps": [{ "minutes": number, "instruction": "..." }],
    "addressesMisconception": "...",
    "checkForUnderstanding": "..."
  },
  "pushPulseCheck": true|false,
  "affectedStudentCount": number
}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Fallback card — used when Gemini returns unparseable/invalid output
// ────────────────────────────────────────────────────────────────────────────

function buildFallbackCard(body: ActionCardBody): ActionCard {
  const topMisconception = body.topMisconceptions[0];
  const gap = topMisconception?.misconceptionName ?? body.topic;

  return {
    urgentSummary: `${totalAffected(body.topMisconceptions)} student(s) are struggling with "${gap}". Consider pausing for a quick class discussion.`,
    suggestedActivity:
      'Ask students to work a similar problem individually on mini-whiteboards, then compare answers with a partner before class review.',
    microLesson: {
      durationMinutes: 12,
      addressesMisconception: gap,
      steps: [
        {
          minutes: 3,
          instruction: `Put one worked example on the board and ask the class to spot where "${gap}" goes wrong — don't correct it yet.`,
        },
        {
          minutes: 4,
          instruction:
            'Work the correct method beside it, saying each step aloud so the contrast with the wrong method is explicit.',
        },
        {
          minutes: 3,
          instruction:
            'Students try one problem on mini-whiteboards; hold up answers so you can scan the room in one look.',
        },
        {
          minutes: 2,
          instruction:
            'Pair a student who got it with one who did not, and have them explain their reasoning to each other.',
        },
      ],
      checkForUnderstanding: `Give one problem designed to trigger "${gap}" — if they avoid the trap, it landed.`,
    },
    pushPulseCheck: true,
    affectedStudentCount: totalAffected(body.topMisconceptions),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/action-card/generate
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
            'Required: classId (string), classSize (number > 0), subject, topic (strings), topMisconceptions (array).',
        },
        { status: 400 },
      );
    }

    // 2 — Early return: no issues detected
    if (hasNoIssues(body.topMisconceptions)) {
      const noIssuesCard: ActionCard = {
        urgentSummary:
          'Class looks good — no critical misconceptions detected.',
        suggestedActivity: null,
        microLesson: null,
        pushPulseCheck: false,
        affectedStudentCount: 0,
      };

      console.log(
        '[action-card/generate] ✅ No issues detected for class',
        body.classId,
      );
      return NextResponse.json(noIssuesCard);
    }

    // 3 — Check in-memory cache
    const cached = getCached(body.classId);
    if (cached) {
      console.log(
        '[action-card/generate] 🗄️ Cache hit for class',
        body.classId,
      );
      return NextResponse.json(cached, {
        headers: { 'X-Cache': 'HIT' },
      });
    }

    // 4 — Call Gemini
    const prompt = buildPrompt(body);

    console.log('[action-card/generate] Calling Gemini for class', {
      classId: body.classId,
      classSize: body.classSize,
      misconceptionCount: body.topMisconceptions.length,
      affectedStudents: totalAffected(body.topMisconceptions),
    });

    const raw = await callGemini(prompt, undefined, {
      system:
        'You are a classroom teaching advisor. Respond ONLY with the JSON object requested. No extra text, no markdown.',
    });

    // 5 — Parse & validate Gemini response
    const parsed = parseGeminiJSON<ActionCard>(raw);

    let card: ActionCard;

    if (parsed && isValidActionCard(parsed)) {
      // Clamp affectedStudentCount to classSize just in case Gemini hallucinates
      card = {
        ...parsed,
        affectedStudentCount: Math.min(
          parsed.affectedStudentCount,
          body.classSize,
        ),
      };
      console.log('[action-card/generate] ✅ Generated card for', body.classId);
    } else {
      // 6 — Fallback
      console.warn(
        '[action-card/generate] ⚠️ Gemini returned invalid response, using fallback.',
        { raw },
      );
      card = buildFallbackCard(body);
    }

    // 7 — Cache & return
    setCached(body.classId, card);
    return NextResponse.json(card, {
      headers: { 'X-Cache': 'MISS' },
    });
  } catch (error) {
    console.error('[action-card/generate] ❌ Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 },
    );
  }
}
