/**
 * Demo-environment seed script for Mosaic Classroom's pitch.
 *
 *   npm run seed              # write to the configured project
 *   npm run seed -- --dry-run # print what would be written, touch nothing
 *
 * Rewritten from the original Firestore version (scripts/seedFirestore.ts) to
 * target Supabase (Postgres + Supabase Auth) instead. The app's real schema
 * lives in src/lib/helpers.ts (the module the live ClassGapMap and ActionCard
 * components actually read) and supabase/schema.sql (the Postgres tables),
 * so this version builds every row to match those exactly rather than
 * inventing its own. Tier is never hand-picked — it is computed with the
 * app's own `calculateTier` so the seeded heatmap is guaranteed to match what
 * the dashboard would compute live from the same active_misconceptions data.
 *
 * Safe to re-run: every row uses a deterministic id/unique-key and the RNG is
 * seeded, so a second run reproduces the same demo state rather than
 * duplicating or drifting. Every Supabase Auth account is looked up by email
 * before being created.
 *
 * Credentials come from NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * in .env.local.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

// Reuse the app's own tier/persistence logic so the seed can never drift from
// what the live dashboard would compute for the same active_misconceptions.
// helpers.ts has no side-effecting imports of its own (only the Supabase JS
// types), so it is safe to pull into a ts-node script that never touches the
// browser or the Next.js runtime.
import {
  calculateTier,
  calculatePersistenceScore,
  type StudentProgress,
  type ActiveMisconception,
  type StudentTier,
  type MisconceptionSeverity,
  type ConfidenceLevel,
} from '../src/lib/helpers';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

const CLASS_ID = 'class_demo_01';
const CLASS_NAME = 'Form 2 Mathematics';
const CLASS_SUBJECT = 'mathematics';
const CLASS_TOPICS = ['fractions', 'decimals', 'percentages'];
/** Read by the kiosk entry page (src/app/kiosk/page.tsx) — must be 6 chars. */
const CLASS_KIOSK_CODE = 'MATH01';

const TEACHER_EMAIL = 'teacher@demo.com';
const TEACHER_PASSWORD = 'demo1234';
const TEACHER_NAME = 'Ms. Aida';

/** Demo-only shared password. Never ship this beyond a demo project. */
const STUDENT_PASSWORD = 'demo1234';

/** Reasonable chunk size for multi-row upserts (well under any practical limit). */
const UPSERT_CHUNK_SIZE = 200;

/** Fixed seed so the class roster and heatmap look identical on every run. */
const RANDOM_SEED = 20260905;

type Group = 'red' | 'yellow' | 'green' | 'blue';

// ────────────────────────────────────────────────────────────────────────────
// Deterministic randomness
// ────────────────────────────────────────────────────────────────────────────

/** mulberry32 — small seeded PRNG, so re-runs reproduce the same demo data. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(RANDOM_SEED);

function randomInt(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)];
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Epoch ms `daysAgo` calendar days back, at a plausible school hour. */
function classroomTimestamp(daysAgo: number): number {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(randomInt(8, 15), randomInt(0, 59), randomInt(0, 59), 0);
  return date.getTime();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// ────────────────────────────────────────────────────────────────────────────
// Misconception catalogue — canonical source is src/data/misconceptions.json
// (NOT the old data/misconceptions.json stopgap, which used a different
// schema and has been removed as part of this update).
// ────────────────────────────────────────────────────────────────────────────

interface MisconceptionCatalogEntry {
  misconceptionId: string;
  subject: string;
  topic: string;
  name: string;
  name_bm: string;
  wrong_answer_pattern: string;
  plain_language_label: string;
  plain_language_label_bm: string;
  remediation_approach: string;
  prerequisite_misconception_id: string | null;
  severity: MisconceptionSeverity;
}

function readMisconceptionCatalog(): MisconceptionCatalogEntry[] {
  const file = path.resolve(process.cwd(), 'src', 'data', 'misconceptions.json');

  if (!fs.existsSync(file)) {
    throw new Error(`Missing misconception catalogue at ${file}`);
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('src/data/misconceptions.json must be a non-empty array');
  }

  const missing = parsed.filter((item: MisconceptionCatalogEntry) => !item?.misconceptionId);
  if (missing.length > 0) {
    throw new Error(`${missing.length} catalogue entries are missing a misconceptionId`);
  }

  return parsed as MisconceptionCatalogEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// Topic-plan model — the building blocks each student is assembled from.
//
// A "topic plan" becomes exactly one student_progress row, matching
// src/lib/helpers.ts's StudentProgress interface (one row per student per
// topic, unique on student_uid/class_id/topic). Tier is computed by
// calculateTier from the fields below — it is never assigned directly — so
// seeded data can never disagree with what the live app would compute for
// the same input.
// ────────────────────────────────────────────────────────────────────────────

interface ActiveMisconceptionSeed {
  misconceptionId: string;
  occurrenceCount: number;
  /** How many days ago this was last seen — lower is more recent/urgent. */
  daysSinceLastSeen: number;
  isCleared?: boolean;
}

interface TopicPlan {
  topic: string;
  activeMisconceptions: ActiveMisconceptionSeed[];
  masteryScore: number;
  consecutiveCorrect: number;
  transferPassed: boolean;
}

interface StudentSeed {
  name: string;
  language: 'en' | 'bm';
  /** Intended headline tier — validated against calculateTier at write time. */
  group: Group;
  topics: TopicPlan[];
}

/**
 * sessionsActive is fixed at 1 across every misconception below. Given the
 * occurrenceCount/daysSinceLastSeen ranges each tier factory uses, dividing
 * by 1 is what keeps RED comfortably above the persistenceScore-3 threshold
 * and YELLOW comfortably below it (see the worked thresholds in the header
 * comment of calculatePersistenceScore) — varying it would blur that line
 * for no benefit to the demo.
 */
const SESSIONS_ACTIVE = 1;

// RED — foundational fraction gaps: both frac_equiv (foundational severity)
// and frac_add_denom active, high occurrence, seen in the last day.
function redFractionsTopic(): TopicPlan {
  return {
    topic: 'fractions',
    activeMisconceptions: [
      { misconceptionId: 'frac_equiv', occurrenceCount: randomInt(4, 6), daysSinceLastSeen: randomInt(0, 1) },
      { misconceptionId: 'frac_add_denom', occurrenceCount: randomInt(4, 6), daysSinceLastSeen: randomInt(0, 1) },
    ],
    masteryScore: randomInt(15, 35),
    consecutiveCorrect: 0,
    transferPassed: false,
  };
}

// YELLOW — actively being worked on: 1-2 non-foundational misconceptions,
// lower occurrence, a little less recent than RED.
function yellowTopic(topic: string, misconceptionIds: string[]): TopicPlan {
  return {
    topic,
    activeMisconceptions: misconceptionIds.map((misconceptionId) => ({
      misconceptionId,
      occurrenceCount: randomInt(2, 3),
      daysSinceLastSeen: randomInt(1, 3),
    })),
    masteryScore: randomInt(45, 62),
    consecutiveCorrect: randomInt(0, 2),
    transferPassed: false,
  };
}

// GREEN — mastered: no uncleared misconceptions, moderate mastery (kept
// under the blue threshold regardless of the other two blue-eligibility
// fields). `clearedMisconceptionId` seeds a recently-cleared entry so
// ClassGapMap's "recently cleared" flag (Peer Explainer trigger) can fire.
function greenTopic(
  topic: string,
  options: { clearedMisconceptionId?: string; daysSinceCleared?: number } = {},
): TopicPlan {
  const activeMisconceptions: ActiveMisconceptionSeed[] = options.clearedMisconceptionId
    ? [
        {
          misconceptionId: options.clearedMisconceptionId,
          occurrenceCount: randomInt(3, 5),
          daysSinceLastSeen: options.daysSinceCleared ?? randomInt(1, 2),
          isCleared: true,
        },
      ]
    : [];

  return {
    topic,
    activeMisconceptions,
    masteryScore: randomInt(65, 78),
    consecutiveCorrect: randomInt(2, 4),
    transferPassed: random() > 0.5,
  };
}

// BLUE — advanced: fully cleared, high mastery, transfer passed on every
// topic (calculateTier's blue branch needs masteryScore>=80,
// consecutiveCorrect>=3 and transferPassed together).
function blueTopic(topic: string): TopicPlan {
  return {
    topic,
    activeMisconceptions: [],
    masteryScore: randomInt(85, 97),
    consecutiveCorrect: randomInt(4, 7),
    transferPassed: true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Demo roster — 20 students, realistic Malaysian names.
//
// Hana and Adam are the two golden-path students from the brief; they are
// counted inside their tier's total (Hana is one of the 6 YELLOW, Adam one
// of the 5 GREEN) rather than added on top, so "20 total" stays literal.
// Priya (the kiosk demo student) is deliberately NOT in this list — see the
// note above her roster entry near the bottom of `seed()`.
// ────────────────────────────────────────────────────────────────────────────

const STUDENTS: StudentSeed[] = [
  // RED (5) — foundational gaps in fractions
  { name: 'Muhammad Haziq bin Abdullah', language: 'bm', group: 'red', topics: [redFractionsTopic()] },
  { name: 'Siti Nurhaliza binti Ismail', language: 'bm', group: 'red', topics: [redFractionsTopic()] },
  { name: 'Gerald anak Jugah', language: 'en', group: 'red', topics: [redFractionsTopic()] },
  { name: 'Muhammad Irfan bin Sulaiman', language: 'bm', group: 'red', topics: [redFractionsTopic()] },
  { name: 'Amirul Hakim bin Yusof', language: 'bm', group: 'red', topics: [redFractionsTopic()] },

  // YELLOW (6, including Hana) — actively working on 1-2 misconceptions
  { name: 'Ahmad Danial bin Zulkifli', language: 'bm', group: 'yellow', topics: [yellowTopic('fractions', ['frac_simplify'])] },
  { name: 'Vishnu Raj a/l Ganesan', language: 'en', group: 'yellow', topics: [yellowTopic('decimals', ['dec_comparison'])] },
  { name: 'Nur Farah Adilah binti Kamal', language: 'bm', group: 'yellow', topics: [yellowTopic('percentages', ['pct_of_calculation'])] },
  { name: 'Aina Sofea binti Roslan', language: 'bm', group: 'yellow', topics: [yellowTopic('fractions', ['frac_multiply_when_adding', 'frac_subtract_larger'])] },
  { name: 'Arjun a/l Ramachandran', language: 'en', group: 'yellow', topics: [yellowTopic('decimals', ['dec_multiply'])] },
  // Golden path: frac_add_denom active — triggers the demo misconception flow.
  { name: 'Hana', language: 'bm', group: 'yellow', topics: [yellowTopic('fractions', ['frac_add_denom'])] },

  // GREEN (5, including Adam) — mastered fractions, some working on decimals
  { name: 'Nurul Aisyah binti Rahman', language: 'bm', group: 'green', topics: [greenTopic('fractions')] },
  { name: 'Lim Mei Ling', language: 'en', group: 'green', topics: [greenTopic('fractions'), yellowTopic('decimals', ['dec_comparison'])] },
  { name: 'Chong Kai Xiang', language: 'en', group: 'green', topics: [greenTopic('fractions'), yellowTopic('decimals', ['dec_fraction_convert'])] },
  { name: 'Dayang Nurain binti Awang', language: 'bm', group: 'green', topics: [greenTopic('fractions'), yellowTopic('decimals', ['dec_multiply'])] },
  // Golden path: frac_add_denom recently cleared — triggers the Peer Explainer.
  { name: 'Adam', language: 'bm', group: 'green', topics: [greenTopic('fractions', { clearedMisconceptionId: 'frac_add_denom', daysSinceCleared: 1 })] },

  // BLUE (4) — advanced across every topic, high mastery
  { name: 'Tan Wei Jie', language: 'en', group: 'blue', topics: [blueTopic('fractions'), blueTopic('decimals'), blueTopic('percentages')] },
  { name: 'Ong Jia Hui', language: 'en', group: 'blue', topics: [blueTopic('fractions'), blueTopic('decimals'), blueTopic('percentages')] },
  { name: 'Kavitha a/p Subramaniam', language: 'en', group: 'blue', topics: [blueTopic('fractions'), blueTopic('decimals'), blueTopic('percentages')] },
  { name: 'Yeoh Zi Ying', language: 'en', group: 'blue', topics: [blueTopic('fractions'), blueTopic('decimals'), blueTopic('percentages')] },
];

// ────────────────────────────────────────────────────────────────────────────
// Answer history — 5-15 per student, mixed correct/incorrect, spread over
// the last 3 calendar days at school hours.
// ────────────────────────────────────────────────────────────────────────────

interface AnswerSeed {
  topic: string;
  isCorrect: boolean;
  isTransferQuestion: boolean;
  misconceptionId: string | null;
  confidenceLevel: ConfidenceLevel;
  timestamp: number;
}

/** Per-group accuracy and answer-count bands, all inside the 5-15 brief. */
const HISTORY_PROFILE: Record<Group, { count: [number, number]; accuracy: number }> = {
  red: { count: [10, 15], accuracy: 0.3 },
  yellow: { count: [8, 13], accuracy: 0.55 },
  green: { count: [6, 11], accuracy: 0.78 },
  blue: { count: [5, 9], accuracy: 0.92 },
};

function buildAnswerHistory(student: StudentSeed): AnswerSeed[] {
  const { count, accuracy } = HISTORY_PROFILE[student.group];
  const total = randomInt(count[0], count[1]);
  const answers: AnswerSeed[] = [];

  for (let i = 0; i < total; i++) {
    const topicPlan = pick(student.topics);
    const isCorrect = random() < accuracy;
    const uncleared = topicPlan.activeMisconceptions.filter((m) => !m.isCleared);
    const misconceptionId = !isCorrect && uncleared.length > 0 ? pick(uncleared).misconceptionId : null;

    const confidenceLevel: ConfidenceLevel = isCorrect
      ? random() < (student.group === 'blue' ? 0.85 : 0.55)
        ? 'knew'
        : 'unsure'
      : random() < (student.group === 'red' ? 0.6 : 0.35)
        ? 'guessed'
        : 'unsure';

    answers.push({
      topic: topicPlan.topic,
      isCorrect,
      isTransferQuestion: isCorrect && random() < 0.2,
      misconceptionId,
      confidenceLevel,
      timestamp: classroomTimestamp(randomInt(0, 2)), // today, yesterday, or the day before
    });
  }

  return answers.sort((a, b) => a.timestamp - b.timestamp);
}

// ────────────────────────────────────────────────────────────────────────────
// Supabase helpers
// ────────────────────────────────────────────────────────────────────────────

function initSupabase(): { supabase: SupabaseClient; url: string } {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (NEXT_PUBLIC_SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return { supabase, url: NEXT_PUBLIC_SUPABASE_URL };
  }

  if (DRY_RUN) {
    const url = 'https://mosaic-classroom-dry-run.supabase.co';
    const supabase = createClient(url, 'dry-run-service-role-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return { supabase, url };
  }

  throw new Error(
    'No Supabase credentials found. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
      'in .env.local (see .env.local.example).',
  );
}

/** Page through auth.admin.listUsers() looking for a matching email. */
async function findAuthUserByEmail(supabase: SupabaseClient, email: string): Promise<User | null> {
  const perPage = 200;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match;

    if (data.users.length < perPage) break; // last page
  }
  return null;
}

/** Create the account, or reset the password/metadata if the email already exists. */
async function upsertAuthUser(
  supabase: SupabaseClient,
  email: string,
  displayName: string,
  password: string,
): Promise<string> {
  if (DRY_RUN) {
    return `dry-run-uid-${email.split('@')[0]}`;
  }

  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: displayName },
  });

  if (!createError && created.user) {
    return created.user.id;
  }

  const alreadyExists =
    createError &&
    /already been registered|already exists|already registered/i.test(createError.message ?? '');

  if (!alreadyExists) {
    throw createError ?? new Error(`Failed to create auth user for ${email}`);
  }

  const existing = await findAuthUserByEmail(supabase, email);
  if (!existing) {
    throw createError;
  }

  const { data: updated, error: updateError } = await supabase.auth.admin.updateUserById(existing.id, {
    password,
    user_metadata: { name: displayName },
  });

  if (updateError) throw updateError;
  return updated.user?.id ?? existing.id;
}

function slugifyEmail(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/\b(bin|binti|a\/l|a\/p|anak)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.+|\.+$/g, '')
      .split('.')
      .filter(Boolean)
      .slice(0, 2)
      .join('.') || 'student';

  let candidate = `${base}@student.demo.com`;
  let suffix = 2;

  while (taken.has(candidate)) {
    candidate = `${base}${suffix}@student.demo.com`;
    suffix += 1;
  }

  taken.add(candidate);
  return candidate;
}

/** Upsert `rows` into `table` in chunks, skipping entirely in dry-run mode. */
async function upsertChunked(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict?: string,
): Promise<void> {
  if (DRY_RUN || rows.length === 0) return;

  for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
    const { error } = onConflict
      ? await supabase.from(table).upsert(batch, { onConflict })
      : await supabase.from(table).upsert(batch);

    if (error) {
      throw new Error(`Failed to upsert into "${table}": ${error.message}`);
    }
  }
}

/**
 * Resolve one ActiveMisconceptionSeed against the catalogue into the full
 * ActiveMisconception shape src/lib/helpers.ts expects, computing
 * persistenceScore with the app's own formula rather than a made-up number.
 * Also embeds an English `name` — not part of the ActiveMisconception type,
 * but ActionCard.tsx reads it opportunistically for a readable label instead
 * of falling back to the raw misconceptionId.
 */
function buildActiveMisconception(
  seed: ActiveMisconceptionSeed,
  catalog: Map<string, MisconceptionCatalogEntry>,
): ActiveMisconception & { name: string } {
  const entry = catalog.get(seed.misconceptionId);
  if (!entry) {
    throw new Error(`Unknown misconceptionId in seed roster: ${seed.misconceptionId}`);
  }

  const lastSeen = Date.now() - seed.daysSinceLastSeen * 86_400_000;

  return {
    misconceptionId: seed.misconceptionId,
    severity: entry.severity,
    occurrenceCount: seed.occurrenceCount,
    persistenceScore: roundTo(calculatePersistenceScore(seed.occurrenceCount, lastSeen, SESSIONS_ACTIVE), 2),
    lastSeen,
    isCleared: seed.isCleared ?? false,
    prerequisite_misconception_id: entry.prerequisite_misconception_id,
    name: entry.name,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Seed
// ────────────────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const catalog = readMisconceptionCatalog();
  const catalogById = new Map(catalog.map((entry) => [entry.misconceptionId, entry]));
  const { supabase, url } = initSupabase();
  const nowIso = new Date().toISOString();

  console.log(`\nMosaic Classroom demo seed${DRY_RUN ? ' (dry run — nothing will be written)' : ''}`);
  console.log(`  project:  ${url}`);
  console.log(`  data:     ${catalog.length} misconceptions, ${STUDENTS.length} students + 1 kiosk-only student\n`);

  // 1. Misconception catalogue, keyed by misconceptionId (-> "id" column).
  const misconceptionRows = catalog.map((entry) => ({
    id: entry.misconceptionId,
    subject: entry.subject,
    topic: entry.topic,
    name: entry.name,
    name_bm: entry.name_bm,
    wrong_answer_pattern: entry.wrong_answer_pattern,
    plain_language_label: entry.plain_language_label,
    plain_language_label_bm: entry.plain_language_label_bm,
    remediation_approach: entry.remediation_approach,
    prerequisite_misconception_id: entry.prerequisite_misconception_id,
    severity: entry.severity,
    updated_at: nowIso,
  }));
  await upsertChunked(supabase, 'misconceptions', misconceptionRows, 'id');
  console.log(`  [1/6] ${DRY_RUN ? 'would upsert' : 'upserted'} ${catalog.length} misconceptions`);

  // 2. Teacher account + class.
  const teacherUid = await upsertAuthUser(supabase, TEACHER_EMAIL, TEACHER_NAME, TEACHER_PASSWORD);
  const profileRows: Record<string, unknown>[] = [];

  profileRows.push({
    id: teacherUid,
    name: TEACHER_NAME,
    email: TEACHER_EMAIL,
    role: 'teacher',
    class_id: CLASS_ID,
    class_name: CLASS_NAME, // read by TeacherLayout's header
    language: 'en',
    kiosk_only: false,
    created_at: nowIso,
  });
  console.log(`  [2/6] teacher ${TEACHER_EMAIL} -> ${teacherUid}`);

  // NOTE: this row references profileRows[0] (the teacher) via a foreign
  // key, so it can't be written until that profile row exists — it's queued
  // here but not upserted until after `profiles` is written below.
  const classRow = {
    id: CLASS_ID,
    teacher_id: teacherUid,
    name: CLASS_NAME,
    subject: CLASS_SUBJECT,
    topics: CLASS_TOPICS,
    kiosk_mode: false,
    kiosk_code: CLASS_KIOSK_CODE,
    student_count: STUDENTS.length,
    created_at: nowIso,
  };
  console.log(`  [3/6] queued class ${CLASS_ID} (${CLASS_NAME}), kiosk code ${CLASS_KIOSK_CODE}`);

  // 3. Students: auth account, profile row, one student_progress row per
  //    topic, and 5-15 historical answers.
  const takenEmails = new Set<string>([TEACHER_EMAIL]);
  const tierTally: Record<Group, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  const misconceptionTally = new Map<string, Set<string>>();
  const studentProgressRows: Record<string, unknown>[] = [];
  const answerRows: Record<string, unknown>[] = [];
  let totalProgressDocs = 0;
  let totalAnswers = 0;

  for (const student of STUDENTS) {
    const email = slugifyEmail(student.name, takenEmails);
    const uid = await upsertAuthUser(supabase, email, student.name, STUDENT_PASSWORD);
    tierTally[student.group] += 1;

    profileRows.push({
      id: uid,
      name: student.name,
      email,
      role: 'student',
      class_id: CLASS_ID,
      class_name: null,
      language: student.language,
      kiosk_only: false,
      created_at: nowIso,
    });

    const observedTiers: StudentTier[] = [];

    for (const topicPlan of student.topics) {
      const activeMisconceptions = topicPlan.activeMisconceptions.map((m) => buildActiveMisconception(m, catalogById));

      const progress: StudentProgress = {
        studentUid: uid,
        classId: CLASS_ID,
        topic: topicPlan.topic,
        tier: 'green', // placeholder — calculateTier below is the real source of truth
        activeMisconceptions,
        masteryScore: topicPlan.masteryScore,
        consecutiveCorrect: topicPlan.consecutiveCorrect,
        transferPassed: topicPlan.transferPassed,
        sessionsActive: SESSIONS_ACTIVE,
      };
      progress.tier = calculateTier(progress);
      observedTiers.push(progress.tier);

      studentProgressRows.push({
        student_uid: progress.studentUid,
        class_id: progress.classId,
        topic: progress.topic,
        tier: progress.tier,
        active_misconceptions: progress.activeMisconceptions,
        mastery_score: progress.masteryScore,
        consecutive_correct: progress.consecutiveCorrect,
        transfer_passed: progress.transferPassed,
        sessions_active: progress.sessionsActive ?? 1,
        last_updated: nowIso,
      });
      totalProgressDocs += 1;

      for (const m of activeMisconceptions) {
        if (m.isCleared) continue; // distribution below reports active gaps only
        if (!misconceptionTally.has(m.misconceptionId)) misconceptionTally.set(m.misconceptionId, new Set());
        misconceptionTally.get(m.misconceptionId)!.add(student.name);
      }
    }

    // Sanity check: the student's primary (first) topic should compute to the
    // tier its group name promises. This never throws for the intentional
    // exceptions (a GREEN student's secondary decimals topic is meant to
    // land yellow) since only topics[0] is checked.
    if (observedTiers[0] !== student.group) {
      console.warn(
        `  ⚠ ${student.name}: primary topic computed to '${observedTiers[0]}', expected '${student.group}' — ` +
          'check the topic-plan thresholds in this script.',
      );
    }

    const answers = buildAnswerHistory(student);
    answers.forEach((answer, index) => {
      answerRows.push({
        id: `${uid}_${index + 1}`,
        student_uid: uid,
        class_id: CLASS_ID,
        topic: answer.topic,
        is_correct: answer.isCorrect,
        is_transfer_question: answer.isTransferQuestion,
        misconception_id: answer.misconceptionId,
        confidence_level: answer.confidenceLevel,
        timestamp: new Date(answer.timestamp).toISOString(),
      });
    });
    totalAnswers += answers.length;

    console.log(
      `        ${student.name.padEnd(28)} ${student.group.padEnd(6)} ` +
        `${student.topics.length} topic doc(s), ${answers.length} answers`,
    );
  }
  console.log(`  [4/6] queued ${STUDENTS.length} students — ${totalProgressDocs} progress rows, ${totalAnswers} answers`);

  // 4. Priya — kiosk demo student.
  //
  // The kiosk flow (src/app/kiosk/[classId]/page.tsx) picks students from
  // `profiles` where class_id + role == 'student', and derives its own
  // progress row from a slug of the *name*, not from the helpers.ts schema
  // every other student above uses. So Priya only needs a roster entry here
  // — no pre-seeded progress (the kiosk page creates a fresh one on first
  // use, which is arguably the better live demo: it shows the cold-start
  // flow). She is intentionally NOT counted in the "20 total" tally above.
  //
  // Unlike the old Firestore version, `profiles.id` carries a foreign key to
  // `auth.users(id)`, so Priya still needs a real (if unused) Supabase Auth
  // account to keep referential integrity — the kiosk flow never signs her
  // in individually, so her password is never used.
  const priyaEmail = slugifyEmail('Priya (kiosk)', takenEmails);
  const priyaUid = await upsertAuthUser(supabase, priyaEmail, 'Priya', STUDENT_PASSWORD);
  profileRows.push({
    id: priyaUid,
    name: 'Priya',
    email: priyaEmail,
    role: 'student',
    class_id: CLASS_ID,
    class_name: null,
    language: 'en',
    kiosk_only: true,
    created_at: nowIso,
  });
  console.log(`  [5/6] queued kiosk-only roster entry for Priya (not counted in the 20)`);

  await upsertChunked(supabase, 'profiles', profileRows, 'id');
  await upsertChunked(supabase, 'classes', [classRow], 'id');
  await upsertChunked(supabase, 'student_progress', studentProgressRows, 'student_uid,class_id,topic');
  await upsertChunked(supabase, 'answers', answerRows, 'id');

  const totalRows = misconceptionRows.length + profileRows.length + 1 + studentProgressRows.length + answerRows.length;
  console.log(`  [6/6] ${DRY_RUN ? 'would write' : 'wrote'} ${totalRows} rows\n`);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('─'.repeat(72));
  console.log('SUMMARY');
  console.log('─'.repeat(72));

  console.log(`\nTotal students created: ${STUDENTS.length} (+ 1 kiosk-only: Priya)`);

  console.log('\nTier distribution:');
  (['red', 'yellow', 'green', 'blue'] as Group[]).forEach((tier) => {
    console.log(`  ${tier.padEnd(6)} ${tierTally[tier]} students`);
  });

  console.log('\nActive misconception distribution (uncleared, by student count):');
  const sortedMisconceptions = [...misconceptionTally.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [misconceptionId, students] of sortedMisconceptions) {
    const label = catalogById.get(misconceptionId)?.name ?? misconceptionId;
    console.log(`  ${String(students.size).padStart(2)}x  ${misconceptionId.padEnd(28)} ${label}`);
  }

  console.log('\nGolden path students:');
  console.log('  Hana  — fractions/yellow, frac_add_denom active (triggers the demo misconception)');
  console.log('  Adam  — fractions/green, frac_add_denom recently cleared (triggers the Peer Explainer)');
  console.log('  Priya — kiosk-only roster entry, no progress yet (for the live kiosk walkthrough)');

  console.log('\nDemo account credentials:');
  console.log(`  Teacher:  ${TEACHER_EMAIL} / ${TEACHER_PASSWORD}`);
  console.log(`  Students: <name-based email> / ${STUDENT_PASSWORD} (see per-student list above for emails)`);
  console.log(`  Kiosk code: ${CLASS_KIOSK_CODE}  (enter at /kiosk to join "${CLASS_NAME}")`);
  console.log('');
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nSeed failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
