'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getApps, initializeApp } from 'firebase/app';
import {
  collection,
  getFirestore,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';

export interface ActionCardProps {
  classId: string;
  classSize: number;
  subject: string;
  topic: string;
}

interface ActiveMisconception {
  misconceptionId: string;
  name?: string;
  persistenceScore: number;
  isCleared: boolean;
}

interface StudentProgressSnapshot {
  studentUid?: string;
  studentName?: string;
  activeMisconceptions?: ActiveMisconception[];
}

interface MisconceptionSummary {
  misconceptionId: string;
  misconceptionName: string;
  studentCount: number;
  persistenceScore: number;
}

interface GeneratedActionCard {
  urgentSummary: string;
  suggestedActivity: string | null;
  pushPulseCheck: boolean;
  affectedStudentCount: number;
}

const ALL_CLEAR_CARD: GeneratedActionCard = {
  urgentSummary: 'Class looks good — no critical misconceptions detected.',
  suggestedActivity: null,
  pushPulseCheck: false,
  affectedStudentCount: 0,
};

function getClientDb() {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };

  if (!config.projectId || !config.apiKey || !config.appId) {
    throw new Error('Firebase client configuration is incomplete.');
  }

  return getFirestore(getApps()[0] ?? initializeApp(config));
}

export function aggregateTopMisconceptions(
  progressDocuments: StudentProgressSnapshot[],
): MisconceptionSummary[] {
  const grouped = new Map<
    string,
    { misconceptionName: string; students: Map<string, number> }
  >();

  progressDocuments.forEach((progress, documentIndex) => {
    const studentKey = progress.studentUid ?? progress.studentName ?? `student-${documentIndex}`;
    const strongestByMisconception = new Map<string, ActiveMisconception>();

    (progress.activeMisconceptions ?? [])
      .filter((misconception) => !misconception.isCleared)
      .forEach((misconception) => {
        const current = strongestByMisconception.get(misconception.misconceptionId);
        if (!current || misconception.persistenceScore > current.persistenceScore) {
          strongestByMisconception.set(misconception.misconceptionId, misconception);
        }
      });

    strongestByMisconception.forEach((misconception) => {
      const group = grouped.get(misconception.misconceptionId) ?? {
        misconceptionName: misconception.name ?? misconception.misconceptionId,
        students: new Map<string, number>(),
      };
      group.students.set(studentKey, misconception.persistenceScore);
      grouped.set(misconception.misconceptionId, group);
    });
  });

  return [...grouped.entries()]
    .map(([misconceptionId, group]) => {
      const studentCount = group.students.size;
      const persistenceScore = Math.max(...group.students.values());
      return {
        misconceptionId,
        misconceptionName: group.misconceptionName,
        studentCount,
        persistenceScore,
      };
    })
    .sort(
      (left, right) =>
        right.studentCount * right.persistenceScore -
        left.studentCount * left.persistenceScore,
    )
    .slice(0, 3);
}

function ActionCardSkeleton() {
  return (
    <div
      aria-label="Loading classroom recommendation"
      className="w-full animate-pulse rounded-2xl border border-slate-200 border-l-8 border-l-slate-300 bg-white p-6 shadow-sm"
    >
      <div className="h-7 w-3/4 rounded bg-slate-200" />
      <div className="mt-5 h-4 w-full rounded bg-slate-100" />
      <div className="mt-3 h-4 w-2/3 rounded bg-slate-100" />
      <div className="mt-7 h-9 w-40 rounded-full bg-slate-100" />
    </div>
  );
}

export default function ActionCard({
  classId,
  classSize,
  subject,
  topic,
}: ActionCardProps) {
  const [card, setCard] = useState<GeneratedActionCard | null>(null);
  const [hasPersistenceFlag, setHasPersistenceFlag] = useState(false);
  const [isPushingPulse, setIsPushingPulse] = useState(false);
  const previousPayload = useRef<string | null>(null);

  useEffect(() => {
    let isCurrent = true;
    let unsubscribe: (() => void) | undefined;

    try {
      const db = getClientDb();
      const progressQuery = query(
        collection(db, 'studentProgress'),
        where('classId', '==', classId),
      );

      unsubscribe = onSnapshot(progressQuery, async (snapshot) => {
        const topMisconceptions = aggregateTopMisconceptions(
          snapshot.docs.map((document) => document.data() as StudentProgressSnapshot),
        );
        const payload = {
          classId,
          classSize,
          subject,
          topic,
          topMisconceptions,
        };
        const payloadKey = JSON.stringify(payload);

        setHasPersistenceFlag(
          topMisconceptions.some((misconception) => misconception.persistenceScore > 3),
        );

        if (topMisconceptions.length === 0) {
          previousPayload.current = payloadKey;
          if (isCurrent) setCard(ALL_CLEAR_CARD);
          return;
        }

        if (previousPayload.current === payloadKey) return;
        previousPayload.current = payloadKey;

        try {
          const response = await fetch('/api/action-card/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (!response.ok) throw new Error('Unable to generate action card.');
          const nextCard = (await response.json()) as GeneratedActionCard;
          if (isCurrent) setCard(nextCard);
        } catch {
          if (isCurrent) {
            setCard({
              urgentSummary: `${topMisconceptions[0].studentCount} student(s) need support with ${topMisconceptions[0].misconceptionName}.`,
              suggestedActivity: 'Run a brief worked-example activity, then check each student with one follow-up question.',
              pushPulseCheck: false,
              affectedStudentCount: topMisconceptions[0].studentCount,
            });
          }
        }
      });
    } catch {
      setCard(ALL_CLEAR_CARD);
    }

    return () => {
      isCurrent = false;
      unsubscribe?.();
    };
  }, [classId, classSize, subject, topic]);

  async function pushPulseCheck() {
    if (!card || isPushingPulse) return;
    setIsPushingPulse(true);

    try {
      await fetch('/api/pulse/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId, subject, topic }),
      });
    } finally {
      setIsPushingPulse(false);
    }
  }

  if (!card) return <ActionCardSkeleton />;

  const tone = hasPersistenceFlag
    ? 'border-l-rose-500 bg-rose-50'
    : card.affectedStudentCount > 0
      ? 'border-l-orange-500 bg-orange-50'
      : 'border-l-emerald-500 bg-emerald-50';

  return (
    <section className={`w-full rounded-2xl border border-slate-200 border-l-8 p-6 shadow-sm ${tone}`} aria-live="polite">
      <AnimatePresence mode="wait">
        <motion.div
          key={`${card.urgentSummary}-${card.affectedStudentCount}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Right now</p>
          <h2 className="mt-2 text-2xl font-bold leading-tight text-slate-900">
            {card.affectedStudentCount === 0 ? `✓ ${card.urgentSummary}` : card.urgentSummary}
          </h2>

          {card.suggestedActivity && (
            <p className="mt-4 max-w-4xl text-base font-medium leading-relaxed text-slate-700">
              {card.suggestedActivity}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <span className="rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm">
              👥 {card.affectedStudentCount} student{card.affectedStudentCount === 1 ? '' : 's'} affected
            </span>

            {card.pushPulseCheck && (
              <button
                type="button"
                onClick={pushPulseCheck}
                disabled={isPushingPulse}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPushingPulse ? 'Creating Pulse Check…' : 'Push Pulse Check →'}
              </button>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
