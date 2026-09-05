export type StudentTier = 'red' | 'yellow' | 'green' | 'blue';
export type MisconceptionSeverity = 'foundational' | 'procedural' | 'conceptual';
export type ConfidenceLevel = 'guessed' | 'unsure' | 'knew';

export interface ActiveMisconception {
  misconceptionId: string;
  severity: MisconceptionSeverity;
  occurrenceCount: number;
  persistenceScore: number;
  lastSeen: number;
  isCleared: boolean;
  prerequisite_misconception_id: string | null;
}

export interface StudentProgress {
  studentUid: string;
  classId: string;
  topic: string;
  tier: StudentTier;
  activeMisconceptions: ActiveMisconception[];
  masteryScore: number;
  consecutiveCorrect: number;
  transferPassed: boolean;
  sessionsActive?: number;
}

export interface Answer {
  studentUid: string;
  classId: string;
  topic: string;
  isCorrect: boolean;
  isTransferQuestion: boolean;
  misconceptionId: string | null;
  confidenceLevel: ConfidenceLevel;
}

export interface NextQuestionParams {
  misconceptionId: string | null;
  difficulty: number;
  isTransferQuestion: boolean;
  isResetQuestion: boolean;
}

interface FirestoreDocument {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
}

interface FirestoreCollection {
  doc(id: string): FirestoreDocument;
}

export interface FirestoreLike {
  collection(name: string): FirestoreCollection;
}

function getUncleared(progress: StudentProgress): ActiveMisconception[] {
  return progress.activeMisconceptions.filter((misconception) => !misconception.isCleared);
}

export function calculateTier(progress: StudentProgress): StudentTier {
  const uncleared = getUncleared(progress);

  if (uncleared.some((misconception) => misconception.severity === 'foundational')) {
    return 'red';
  }

  if (uncleared.some((misconception) => misconception.persistenceScore > 3)) {
    return 'red';
  }

  if (uncleared.length > 0) {
    return 'yellow';
  }

  if (
    progress.masteryScore >= 80 &&
    progress.consecutiveCorrect >= 3 &&
    progress.transferPassed
  ) {
    return 'blue';
  }

  return 'green';
}

export function calculatePersistenceScore(
  occurrenceCount: number,
  lastSeenMs: number,
  sessionsActive: number,
): number {
  const daysSince = (Date.now() - lastSeenMs) / 86_400_000;
  const recencyWeight = Math.max(0, 1 - daysSince / 7);

  return (occurrenceCount * recencyWeight) / Math.max(1, sessionsActive);
}

export function checkFrustrationThreshold(
  recentAnswers: Answer[],
  activeMisconceptionId: string,
): boolean {
  return recentAnswers
    .slice(-4)
    .filter(
      (answer) =>
        !answer.isCorrect && answer.misconceptionId === activeMisconceptionId,
    ).length >= 4;
}

export function handleCorrectAnswer(
  answer: Answer,
  progress: StudentProgress,
): { nextAction: string; misconceptionId?: string } {
  if (answer.confidenceLevel === 'guessed') {
    return { nextAction: 'serve_verification' };
  }

  if (answer.confidenceLevel === 'unsure') {
    return { nextAction: 'serve_confirmation' };
  }

  if (answer.isTransferQuestion && answer.misconceptionId) {
    return {
      nextAction: 'clear_misconception',
      misconceptionId: answer.misconceptionId,
    };
  }

  const consecutiveCorrect = progress.consecutiveCorrect + 1;
  if (consecutiveCorrect >= 3 && !progress.transferPassed && answer.misconceptionId) {
    return {
      nextAction: 'serve_transfer_question',
      misconceptionId: answer.misconceptionId,
    };
  }

  return { nextAction: 'continue_practice' };
}

function getDifficulty(tier: StudentTier): number {
  if (tier === 'red') return 1;
  if (tier === 'yellow') return 2;
  return 3;
}

export function getNextQuestionParams(
  progress: StudentProgress,
  sessionHistory: Answer[],
): NextQuestionParams {
  const active = getUncleared(progress)
    .sort((left, right) => right.persistenceScore - left.persistenceScore)[0];
  const difficulty = getDifficulty(progress.tier);

  if (!active) {
    return {
      misconceptionId: null,
      difficulty,
      isTransferQuestion: false,
      isResetQuestion: false,
    };
  }

  if (checkFrustrationThreshold(sessionHistory, active.misconceptionId)) {
    return {
      misconceptionId: null,
      difficulty,
      isTransferQuestion: false,
      isResetQuestion: true,
    };
  }

  const prerequisite = active.prerequisite_misconception_id
    ? getUncleared(progress).find(
        (misconception) =>
          misconception.misconceptionId === active.prerequisite_misconception_id,
      )
    : undefined;
  const misconceptionId = prerequisite?.misconceptionId ?? active.misconceptionId;

  if (progress.consecutiveCorrect >= 3 && !progress.transferPassed) {
    return {
      misconceptionId,
      difficulty,
      isTransferQuestion: true,
      isResetQuestion: false,
    };
  }

  return {
    misconceptionId,
    difficulty,
    isTransferQuestion: false,
    isResetQuestion: false,
  };
}

function createProgress(answer: Answer): StudentProgress {
  return {
    studentUid: answer.studentUid,
    classId: answer.classId,
    topic: answer.topic,
    tier: 'green',
    activeMisconceptions: [],
    masteryScore: 0,
    consecutiveCorrect: 0,
    transferPassed: false,
    sessionsActive: 1,
  };
}

function toProgress(answer: Answer, data: Record<string, unknown> | undefined): StudentProgress {
  const fallback = createProgress(answer);
  if (!data) return fallback;

  return {
    ...fallback,
    ...data,
    activeMisconceptions: Array.isArray(data.activeMisconceptions)
      ? (data.activeMisconceptions as ActiveMisconception[])
      : [],
  } as StudentProgress;
}

async function lookupMisconception(
  db: FirestoreLike,
  misconceptionId: string,
): Promise<Pick<ActiveMisconception, 'severity' | 'prerequisite_misconception_id'>> {
  const snapshot = await db.collection('misconceptions').doc(misconceptionId).get();
  const data = snapshot.data();

  return {
    severity: (data?.severity as MisconceptionSeverity | undefined) ?? 'conceptual',
    prerequisite_misconception_id:
      (data?.prerequisite_misconception_id as string | null | undefined) ?? null,
  };
}

export async function updateStudentProgress(
  db: FirestoreLike,
  answerId: string,
  answer: Answer,
  isCorrect: boolean,
  misconceptionId: string | null,
  confidenceLevel: ConfidenceLevel,
): Promise<void> {
  const progressId = `${answer.studentUid}_${answer.classId}_${answer.topic}`;
  const progressRef = db.collection('studentProgress').doc(progressId);
  const existing = await progressRef.get();
  const progress = toProgress(answer, existing.data());
  const resolvedAnswer: Answer = {
    ...answer,
    isCorrect,
    misconceptionId,
    confidenceLevel,
  };
  const now = Date.now();

  if (isCorrect) {
    const result = handleCorrectAnswer(resolvedAnswer, progress);
    progress.consecutiveCorrect += 1;

    if (result.nextAction === 'clear_misconception' && result.misconceptionId) {
      progress.activeMisconceptions = progress.activeMisconceptions.map(
        (misconception) =>
          misconception.misconceptionId === result.misconceptionId
            ? { ...misconception, isCleared: true }
            : misconception,
      );
      progress.transferPassed = true;
    }
  } else {
    progress.consecutiveCorrect = 0;
    progress.transferPassed = false;

    if (misconceptionId) {
      const existingMisconception = progress.activeMisconceptions.find(
        (misconception) => misconception.misconceptionId === misconceptionId,
      );
      const sessionsActive = Math.max(1, progress.sessionsActive ?? 1);

      if (existingMisconception) {
        existingMisconception.occurrenceCount += 1;
        existingMisconception.lastSeen = now;
        existingMisconception.isCleared = false;
        existingMisconception.persistenceScore = calculatePersistenceScore(
          existingMisconception.occurrenceCount,
          now,
          sessionsActive,
        );
      } else {
        const definition = await lookupMisconception(db, misconceptionId);
        progress.activeMisconceptions.push({
          misconceptionId,
          ...definition,
          occurrenceCount: 1,
          persistenceScore: calculatePersistenceScore(1, now, sessionsActive),
          lastSeen: now,
          isCleared: false,
        });
      }
    }
  }

  progress.tier = calculateTier(progress);

  await progressRef.set({ ...progress, lastUpdated: now }, { merge: true });
  await db.collection('answers').doc(answerId).set(
    { misconceptionId, isCorrect, confidenceLevel, timestamp: now },
    { merge: true },
  );
}
