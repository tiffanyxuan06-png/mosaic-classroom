import { db } from '@/lib/firebase';
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  onSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: This module uses the Firebase CLIENT SDK (not Admin SDK) so it can be
// imported safely in 'use client' components that need Firestore realtime
// listeners.  The `db` from @/lib/firebase is the Admin SDK — so this file
// uses a separate client-SDK initialisation.
// ─────────────────────────────────────────────────────────────────────────────

export type MasteryTier = 'red' | 'yellow' | 'green' | 'blue';

export interface TopicProgress {
  topic: string;
  tier: MasteryTier;
  /** Active misconception for this topic (red/yellow tier). */
  activeMisconceptionId: string | null;
  activeMisconceptionLabel: string | null;
  activeMisconceptionLabel_bm: string | null;
  questionsAttempted: number;
  correctInARow: number;
  lastUpdated: number; // epoch ms
}

export interface StudentProgress {
  studentId: string;
  classId: string;
  subject: string;
  /** The topic the student is currently working on. */
  currentTopic: string;
  currentMissionIndex: number; // 0-based
  topics: Record<string, TopicProgress>;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default progress scaffold — used when a student record doesn't yet exist
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TOPICS: TopicProgress[] = [
  {
    topic: 'fractions',
    tier: 'red',
    activeMisconceptionId: 'frac_equiv',
    activeMisconceptionLabel:
      'Multiply or divide the top and bottom by the same number to keep the value equal.',
    activeMisconceptionLabel_bm:
      'Darab atau bahagi pengangka dan penyebut dengan nombor yang sama supaya nilainya kekal sama.',
    questionsAttempted: 0,
    correctInARow: 0,
    lastUpdated: Date.now(),
  },
  {
    topic: 'decimals',
    tier: 'yellow',
    activeMisconceptionId: 'dec_place_value',
    activeMisconceptionLabel:
      'Line up the decimal points so ones, tenths, and hundredths stay in their columns.',
    activeMisconceptionLabel_bm:
      'Jajarkan titik perpuluhan supaya sa, persepuluh dan perseratus kekal dalam lajur masing-masing.',
    questionsAttempted: 0,
    correctInARow: 0,
    lastUpdated: Date.now(),
  },
  {
    topic: 'percentages',
    tier: 'green',
    activeMisconceptionId: null,
    activeMisconceptionLabel: null,
    activeMisconceptionLabel_bm: null,
    questionsAttempted: 0,
    correctInARow: 0,
    lastUpdated: Date.now(),
  },
];

export function makeDefaultProgress(
  studentId: string,
  classId: string,
): StudentProgress {
  const topics: Record<string, TopicProgress> = {};
  DEFAULT_TOPICS.forEach((t) => {
    topics[t.topic] = { ...t };
  });

  return {
    studentId,
    classId,
    subject: 'mathematics',
    currentTopic: 'fractions',
    currentMissionIndex: 0,
    topics,
    updatedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier promotion rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines whether a topic tier should be promoted based on answer stream.
 *
 * Promotion ladder: red → yellow → green → blue
 * - red   → yellow : 2 correct in a row on the misconception
 * - yellow → green : 3 correct in a row (including transfer question)
 * - green → blue   : 5 correct in a row with confidence = 'knew'
 */
export function computeNewTier(
  current: TopicProgress,
  isCorrect: boolean,
  isTransferQuestion: boolean,
  confidenceLevel: 'guessed' | 'unsure' | 'knew',
): Partial<TopicProgress> {
  const streak = isCorrect ? current.correctInARow + 1 : 0;

  const patch: Partial<TopicProgress> = {
    questionsAttempted: current.questionsAttempted + 1,
    correctInARow: streak,
    lastUpdated: Date.now(),
  };

  if (!isCorrect) {
    // Regression: green/blue students who get one wrong drop back a tier
    if (current.tier === 'blue') patch.tier = 'green';
    // red/yellow stay, just reset streak
    return patch;
  }

  // Promotion checks
  if (current.tier === 'red' && streak >= 2) {
    patch.tier = 'yellow';
    patch.correctInARow = 0;
  } else if (current.tier === 'yellow' && streak >= 3 && isTransferQuestion) {
    patch.tier = 'green';
    patch.activeMisconceptionId = null;
    patch.activeMisconceptionLabel = null;
    patch.activeMisconceptionLabel_bm = null;
    patch.correctInARow = 0;
  } else if (
    current.tier === 'green' &&
    streak >= 5 &&
    confidenceLevel === 'knew'
  ) {
    patch.tier = 'blue';
    patch.correctInARow = 0;
  }

  return patch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore path helper
// ─────────────────────────────────────────────────────────────────────────────

function progressDocPath(studentId: string) {
  return `studentProgress/${studentId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// updateStudentProgress  — called after each question submission
// ─────────────────────────────────────────────────────────────────────────────

export interface AnswerPayload {
  studentId: string;
  classId: string;
  topic: string;
  isCorrect: boolean;
  isTransferQuestion: boolean;
  isResetQuestion: boolean;
  confidenceLevel: 'guessed' | 'unsure' | 'knew';
  misconceptionId: string | null;
  misconceptionLabel: string | null;
  misconceptionLabel_bm: string | null;
  timeSpentMs: number;
  answerChanges: number;
}

/**
 * Reads the student's progress document, applies tier logic, and writes it
 * back. Creates the document if it doesn't exist yet.
 *
 * Returns the updated StudentProgress.
 */
export async function updateStudentProgress(
  payload: AnswerPayload,
): Promise<StudentProgress> {
  // Dynamically import the client-side Firestore to avoid bundling firebase
  // admin into the client bundle.  The `db` export from @/lib/firebase is
  // Admin-only, so we import the client SDK here.
  const { initializeApp, getApps } = await import('firebase/app');
  const { getFirestore, doc: clientDoc, getDoc: clientGetDoc, setDoc: clientSetDoc } =
    await import('firebase/firestore');

  // Minimal client init (reads from env — Next.js exposes NEXT_PUBLIC_ vars)
  const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  };

  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp(firebaseConfig, 'client');
  const clientDb = getFirestore(app);

  const ref = clientDoc(clientDb, progressDocPath(payload.studentId));
  const snap = await clientGetDoc(ref);

  let progress: StudentProgress = snap.exists()
    ? (snap.data() as StudentProgress)
    : makeDefaultProgress(payload.studentId, payload.classId);

  // Ensure the topic entry exists
  if (!progress.topics[payload.topic]) {
    progress.topics[payload.topic] = {
      topic: payload.topic,
      tier: 'red',
      activeMisconceptionId: payload.misconceptionId,
      activeMisconceptionLabel: payload.misconceptionLabel,
      activeMisconceptionLabel_bm: payload.misconceptionLabel_bm,
      questionsAttempted: 0,
      correctInARow: 0,
      lastUpdated: Date.now(),
    };
  }

  const topicProgress = progress.topics[payload.topic];
  const patch = computeNewTier(
    topicProgress,
    payload.isCorrect,
    payload.isTransferQuestion,
    payload.confidenceLevel,
  );

  // Update active misconception if a new one was classified
  if (
    !payload.isCorrect &&
    payload.misconceptionId &&
    payload.misconceptionId !== topicProgress.activeMisconceptionId
  ) {
    patch.activeMisconceptionId = payload.misconceptionId;
    patch.activeMisconceptionLabel = payload.misconceptionLabel;
    patch.activeMisconceptionLabel_bm = payload.misconceptionLabel_bm;
  }

  progress = {
    ...progress,
    updatedAt: Date.now(),
    topics: {
      ...progress.topics,
      [payload.topic]: { ...topicProgress, ...patch },
    },
  };

  await clientSetDoc(ref, progress, { merge: true });
  return progress;
}

// ─────────────────────────────────────────────────────────────────────────────
// subscribeStudentProgress — Firestore realtime listener for the Mastery Map
// ─────────────────────────────────────────────────────────────────────────────

export function subscribeStudentProgress(
  studentId: string,
  onChange: (progress: StudentProgress | null) => void,
): Promise<Unsubscribe> {
  return (async () => {
    const { initializeApp, getApps } = await import('firebase/app');
    const { getFirestore, doc: clientDoc, onSnapshot: clientOnSnapshot } =
      await import('firebase/firestore');

    const firebaseConfig = {
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    };

    const app =
      getApps().length > 0
        ? getApps()[0]
        : initializeApp(firebaseConfig, 'client');
    const clientDb = getFirestore(app);

    const ref = clientDoc(clientDb, progressDocPath(studentId));
    return clientOnSnapshot(ref, (snap) => {
      onChange(snap.exists() ? (snap.data() as StudentProgress) : null);
    });
  })();
}

// ─────────────────────────────────────────────────────────────────────────────
// getNextQuestionParams — derives the next quiz call params from progress
// ─────────────────────────────────────────────────────────────────────────────

export interface NextQuestionParams {
  subject: string;
  topic: string;
  difficulty: 1 | 2 | 3;
  activeMisconceptionId: string | null;
  activeMisconceptionDescription: string | null;
  isTransferQuestion: boolean;
  isResetQuestion: boolean;
}

export function getNextQuestionParams(
  progress: StudentProgress,
  lastWasCorrect: boolean,
  lastWasTransfer: boolean,
  consecutiveCorrect: number,
  recentQuestions: string[],
): NextQuestionParams {
  const topicProgress = progress.topics[progress.currentTopic];
  const tier = topicProgress?.tier ?? 'red';

  // After 3 consecutive correct answers that aren't yet transfer, push a transfer q
  const isTransferQuestion =
    lastWasCorrect &&
    !lastWasTransfer &&
    consecutiveCorrect >= 2 &&
    (tier === 'yellow' || tier === 'green');

  // After a wrong answer on green/blue tier, offer a reset question
  const isResetQuestion = !lastWasCorrect && (tier === 'green' || tier === 'blue');

  const difficultyMap: Record<MasteryTier, 1 | 2 | 3> = {
    red: 1,
    yellow: 2,
    green: 2,
    blue: 3,
  };

  return {
    subject: progress.subject,
    topic: progress.currentTopic,
    difficulty: difficultyMap[tier],
    activeMisconceptionId: topicProgress?.activeMisconceptionId ?? null,
    activeMisconceptionDescription: topicProgress?.activeMisconceptionLabel ?? null,
    isTransferQuestion,
    isResetQuestion,
  };
}
