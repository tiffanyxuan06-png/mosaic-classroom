/**
 * One-time seed script for Mosaic Classroom.
 *
 *   npm run seed              # write to the configured project
 *   npm run seed -- --dry-run # print what would be written, touch nothing
 *
 * Safe to re-run: every document is written with a deterministic ID and every
 * auth account is looked up by email before being created, so a second run
 * updates the demo data in place rather than duplicating it.
 *
 * Credentials come from either GOOGLE_APPLICATION_CREDENTIALS (path to a
 * service account JSON) or the FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
 * FIREBASE_PRIVATE_KEY triple in .env.local. Point FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST at the emulators to seed locally.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';
import { cert, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');

const CLASS_ID = 'class_demo_01';
const CLASS_NAME = 'Form 2 Mathematics';
const CLASS_SUBJECT = 'mathematics';
const CLASS_TOPICS = ['fractions', 'decimals', 'percentages'];

const TEACHER_EMAIL = 'teacher@demo.com';
const TEACHER_PASSWORD = 'demo1234';
const TEACHER_NAME = 'Ms. Aida';

/** Demo-only shared password. Never ship this beyond a demo project. */
const STUDENT_PASSWORD = 'demo1234';

/** Firestore caps a write batch at 500 operations. */
const BATCH_LIMIT = 450;

/** Fixed seed so the heatmap looks identical on every run. */
const RANDOM_SEED = 20260905;

/**
 * Heatmap states, worst first. The teacher dashboard colours cells by these:
 *
 *   red    - misconception confirmed and still active, needs intervention
 *   yellow - partially resolved, inconsistent across recent attempts
 *   green  - resolved, answering correctly with sound reasoning
 *   blue   - mastered and extending, ready for enrichment
 */
const STATES = ['red', 'yellow', 'green', 'blue'] as const;
type MisconceptionState = (typeof STATES)[number];

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

interface Misconception {
  misconceptionId: string;
  subject: string;
  topic: string;
  form: number;
  label: string;
  label_ms?: string;
  description: string;
  studentExample?: string;
  correctReasoning?: string;
  diagnosticQuestion?: string;
  remediationHint?: string;
  /** 0..1, used to weight how often students still struggle with it. */
  difficulty?: number;
  severity?: 'low' | 'medium' | 'high';
  prerequisites?: string[];
}

interface StudentSeed {
  name: string;
  language: 'en' | 'ms';
  /** 0..1 proficiency, drives the mix of states on the heatmap. */
  ability: number;
}

interface ProgressEntry {
  status: MisconceptionState;
  attempts: number;
  correct: number;
  confidence: number;
  hintsUsed: number;
  evidenceCount: number;
  lastSeenAt: string;
  resolvedAt: string | null;
}

// --------------------------------------------------------------------------
// Demo roster - a realistic Malaysian Form 2 class
// --------------------------------------------------------------------------

const STUDENTS: StudentSeed[] = [
  { name: 'Nurul Aisyah binti Rahman', language: 'ms', ability: 0.86 },
  { name: 'Muhammad Haziq bin Abdullah', language: 'ms', ability: 0.34 },
  { name: 'Tan Wei Jie', language: 'en', ability: 0.92 },
  { name: 'Priya Darshini a/p Muniandy', language: 'en', ability: 0.71 },
  { name: 'Siti Nurhaliza binti Ismail', language: 'ms', ability: 0.22 },
  { name: 'Lim Mei Ling', language: 'en', ability: 0.63 },
  { name: 'Ahmad Danial bin Zulkifli', language: 'ms', ability: 0.48 },
  { name: 'Vishnu Raj a/l Ganesan', language: 'en', ability: 0.55 },
  { name: 'Ong Jia Hui', language: 'en', ability: 0.78 },
  { name: 'Nur Farah Adilah binti Kamal', language: 'ms', ability: 0.41 },
  { name: 'Gerald anak Jugah', language: 'en', ability: 0.29 },
  { name: 'Chong Kai Xiang', language: 'en', ability: 0.67 },
  { name: 'Kavitha a/p Subramaniam', language: 'en', ability: 0.83 },
  { name: 'Muhammad Irfan bin Sulaiman', language: 'ms', ability: 0.17 },
  { name: 'Dayang Nurain binti Awang', language: 'ms', ability: 0.59 },
  { name: 'Yeoh Zi Ying', language: 'en', ability: 0.74 },
  { name: 'Aina Sofea binti Roslan', language: 'ms', ability: 0.5 },
  { name: 'Arjun a/l Ramachandran', language: 'en', ability: 0.38 },
  { name: 'Lee Chun Meng', language: 'en', ability: 0.95 },
  { name: 'Amirul Hakim bin Yusof', language: 'ms', ability: 0.26 },
];

// --------------------------------------------------------------------------
// Deterministic randomness
// --------------------------------------------------------------------------

/** mulberry32 - small seeded PRNG, so re-runs produce the same heatmap. */
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

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// --------------------------------------------------------------------------
// Progress generation
// --------------------------------------------------------------------------

/**
 * Pick a state from the student's ability against the item's difficulty, with
 * enough jitter that strong students still show the odd red cell. Clustering by
 * ability (rather than uniform noise) is what makes the heatmap read as a real
 * class: visible rows of struggle, visible columns of shared misconception.
 */
function pickState(ability: number, difficulty: number): MisconceptionState {
  // Both inputs are compressed before comparison and the jitter is wide, so
  // even the weakest student shows some green and the strongest keeps a
  // problem area. A row of one flat colour would not look like a real class.
  const margin = (0.2 + ability * 0.65) - (0.25 + difficulty * 0.5) + (random() - 0.5) * 0.7;

  if (margin < -0.13) return 'red';
  if (margin < 0.07) return 'yellow';
  if (margin < 0.32) return 'green';
  return 'blue';
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(randomInt(8, 16), randomInt(0, 59), 0, 0);
  return date.toISOString();
}

function buildProgressEntry(state: MisconceptionState): ProgressEntry {
  const attempts = randomInt(2, 9);

  // Accuracy band per state, so the numbers agree with the colour.
  const accuracy = {
    red: 0.05 + random() * 0.25,
    yellow: 0.35 + random() * 0.25,
    green: 0.65 + random() * 0.2,
    blue: 0.85 + random() * 0.15,
  }[state];

  const correct = Math.min(attempts, Math.round(attempts * accuracy));
  const lastSeen = daysAgo(randomInt(0, 21));

  return {
    status: state,
    attempts,
    correct,
    confidence: roundTo(0.4 + accuracy * 0.55 + random() * 0.05, 2),
    hintsUsed: state === 'red' ? randomInt(2, 6) : state === 'yellow' ? randomInt(1, 3) : randomInt(0, 1),
    evidenceCount: randomInt(1, 4),
    lastSeenAt: lastSeen,
    resolvedAt: state === 'green' || state === 'blue' ? lastSeen : null,
  };
}

function summarise(entries: Record<string, ProgressEntry>) {
  const counts: Record<MisconceptionState, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  let attempts = 0;
  let correct = 0;

  for (const entry of Object.values(entries)) {
    counts[entry.status] += 1;
    attempts += entry.attempts;
    correct += entry.correct;
  }

  const total = Object.keys(entries).length || 1;

  return {
    counts,
    attempts,
    correct,
    // 0..100, weighted so blue counts full and yellow counts partially.
    masteryScore: Math.round(((counts.blue + counts.green * 0.85 + counts.yellow * 0.4) / total) * 100),
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

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

function readMisconceptions(): Misconception[] {
  const file = path.resolve(process.cwd(), 'data', 'misconceptions.json');

  if (!fs.existsSync(file)) {
    throw new Error(`Missing seed data at ${file}`);
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('data/misconceptions.json must be a non-empty array');
  }

  const missing = parsed.filter((item: Misconception) => !item?.misconceptionId);
  if (missing.length > 0) {
    throw new Error(`${missing.length} entries are missing a misconceptionId`);
  }

  return parsed as Misconception[];
}

function initFirebase(): { app: App; db: Firestore; auth: Auth } {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS } =
    process.env;

  let app: App;

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    app = initializeApp({
      credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        // .env files store the key with escaped newlines.
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      projectId: FIREBASE_PROJECT_ID,
    });
  } else if (GOOGLE_APPLICATION_CREDENTIALS) {
    app = initializeApp({ credential: applicationDefault() });
  } else if (DRY_RUN) {
    // A dry run never touches the network, so it does not need real credentials.
    app = initializeApp({ projectId: 'mosaic-classroom-dry-run' });
  } else {
    throw new Error(
      'No Firebase credentials found. Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY ' +
        'in .env.local, or point GOOGLE_APPLICATION_CREDENTIALS at a service account JSON file.',
    );
  }

  return { app, db: getFirestore(app), auth: getAuth(app) };
}

/** Create the account, or reset the password if the email already exists. */
async function upsertAuthUser(
  auth: Auth,
  email: string,
  displayName: string,
  password: string,
): Promise<string> {
  if (DRY_RUN) {
    return `dry-run-uid-${email.split('@')[0]}`;
  }

  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { displayName, password, emailVerified: true });
    return existing.uid;
  } catch (error) {
    if ((error as { code?: string }).code !== 'auth/user-not-found') {
      throw error;
    }

    const created = await auth.createUser({ email, password, displayName, emailVerified: true });
    return created.uid;
  }
}

type PendingWrite = { ref: FirebaseFirestore.DocumentReference; data: FirebaseFirestore.DocumentData };

async function commitAll(db: Firestore, writes: PendingWrite[]): Promise<void> {
  if (DRY_RUN) return;

  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const { ref, data } of writes.slice(i, i + BATCH_LIMIT)) {
      batch.set(ref, data);
    }
    await batch.commit();
  }
}

// --------------------------------------------------------------------------
// Seed
// --------------------------------------------------------------------------

async function seed(): Promise<void> {
  const misconceptions = readMisconceptions();
  const { db, auth } = initFirebase();
  const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? '(from credentials)';

  console.log(`\nMosaic Classroom seed${DRY_RUN ? ' (dry run - nothing will be written)' : ''}`);
  console.log(`  project:  ${projectId}`);
  console.log(`  emulator: ${process.env.FIRESTORE_EMULATOR_HOST ?? 'no (writing to the live project)'}`);
  console.log(`  data:     ${misconceptions.length} misconceptions, ${STUDENTS.length} students\n`);

  const writes: PendingWrite[] = [];
  const now = FieldValue.serverTimestamp();

  // 1. Misconceptions, keyed by misconceptionId.
  for (const misconception of misconceptions) {
    writes.push({
      ref: db.collection('misconceptions').doc(misconception.misconceptionId),
      data: { ...misconception, updatedAt: now },
    });
  }
  console.log(`  [1/5] queued ${misconceptions.length} misconceptions`);

  // 2. Teacher account.
  const teacherUid = await upsertAuthUser(auth, TEACHER_EMAIL, TEACHER_NAME, TEACHER_PASSWORD);
  writes.push({
    ref: db.collection('users').doc(teacherUid),
    data: {
      uid: teacherUid,
      name: TEACHER_NAME,
      email: TEACHER_EMAIL,
      role: 'teacher',
      classId: CLASS_ID,
      language: 'en',
      createdAt: now,
    },
  });
  console.log(`  [2/5] teacher ${TEACHER_EMAIL} -> ${teacherUid}`);

  // 3. Class.
  writes.push({
    ref: db.collection('classes').doc(CLASS_ID),
    data: {
      classId: CLASS_ID,
      teacherUid,
      name: CLASS_NAME,
      subject: CLASS_SUBJECT,
      topics: CLASS_TOPICS,
      kioskMode: false,
      studentCount: STUDENTS.length,
      createdAt: now,
    },
  });
  console.log(`  [3/5] class ${CLASS_ID} (${CLASS_NAME})`);

  // 4 + 5. Students, their user docs, and their progress docs.
  const takenEmails = new Set<string>();
  const tally: Record<MisconceptionState, number> = { red: 0, yellow: 0, green: 0, blue: 0 };

  for (const [index, student] of STUDENTS.entries()) {
    const email = slugifyEmail(student.name, takenEmails);
    const uid = await upsertAuthUser(auth, email, student.name, STUDENT_PASSWORD);

    writes.push({
      ref: db.collection('users').doc(uid),
      data: {
        uid,
        name: student.name,
        email,
        role: 'student',
        classId: CLASS_ID,
        language: student.language,
        seatNumber: index + 1,
        createdAt: now,
      },
    });

    const entries: Record<string, ProgressEntry> = {};
    for (const misconception of misconceptions) {
      const state = pickState(student.ability, misconception.difficulty ?? 0.5);
      entries[misconception.misconceptionId] = buildProgressEntry(state);
      tally[state] += 1;
    }

    const summary = summarise(entries);

    writes.push({
      // One progress doc per student, addressed by uid for cheap lookups.
      ref: db.collection('studentProgress').doc(uid),
      data: {
        uid,
        studentName: student.name,
        classId: CLASS_ID,
        subject: CLASS_SUBJECT,
        language: student.language,
        misconceptions: entries,
        statusCounts: summary.counts,
        totalAttempts: summary.attempts,
        totalCorrect: summary.correct,
        masteryScore: summary.masteryScore,
        lastActiveAt: daysAgo(randomInt(0, 4)),
        updatedAt: now,
      },
    });

    console.log(
      `        ${String(index + 1).padStart(2, '0')}. ${student.name.padEnd(32)} ${email.padEnd(30)} ` +
        `mastery ${String(summary.masteryScore).padStart(3)}%  ` +
        `R${summary.counts.red} Y${summary.counts.yellow} G${summary.counts.green} B${summary.counts.blue}`,
    );
  }
  console.log(`  [4/5] queued ${STUDENTS.length} student accounts and user docs`);
  console.log(`  [5/5] queued ${STUDENTS.length} studentProgress docs`);

  await commitAll(db, writes);

  const totalCells = STUDENTS.length * misconceptions.length;
  const pct = (n: number) => `${Math.round((n / totalCells) * 100)}%`;

  console.log(`\n${DRY_RUN ? 'Would write' : 'Wrote'} ${writes.length} documents.`);
  console.log(
    `Heatmap mix across ${totalCells} cells: ` +
      `red ${tally.red} (${pct(tally.red)}), yellow ${tally.yellow} (${pct(tally.yellow)}), ` +
      `green ${tally.green} (${pct(tally.green)}), blue ${tally.blue} (${pct(tally.blue)})`,
  );
  console.log(`\nSign in as ${TEACHER_EMAIL} / ${TEACHER_PASSWORD}`);
  console.log(`Students share the password ${STUDENT_PASSWORD} - demo projects only.\n`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nSeed failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
