'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { supabase } from '@/lib/supabase-client';

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

function rowToProgressSnapshot(row: Record<string, unknown>): StudentProgressSnapshot {
  return {
    studentUid: row.student_uid as string | undefined,
    activeMisconceptions: Array.isArray(row.active_misconceptions)
      ? (row.active_misconceptions as ActiveMisconception[])
      : [],
  };
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

    async function handleRows(rows: Record<string, unknown>[]) {
      const topMisconceptions = aggregateTopMisconceptions(
        rows.map(rowToProgressSnapshot),
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
    }

    // Initial one-shot fetch — Supabase realtime doesn't emit the current
    // rows on subscribe, unlike Firestore's onSnapshot.
    let rowsByKey = new Map<string, Record<string, unknown>>();

    supabase
      .from('student_progress')
      .select('*')
      .eq('class_id', classId)
      .then(({ data, error }) => {
        if (!isCurrent) return;
        if (error) {
          console.error('[ActionCard] Error loading student progress:', error);
          setCard(ALL_CLEAR_CARD);
          return;
        }
        rowsByKey = new Map(
          (data ?? []).map((row) => [`${row.student_uid}::${row.topic}`, row]),
        );
        void handleRows(Array.from(rowsByKey.values()));
      });

    const channel = supabase
      .channel(`action-card-${classId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'student_progress',
          filter: `class_id=eq.${classId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Record<string, unknown>;
            rowsByKey.delete(`${oldRow.student_uid}::${oldRow.topic}`);
          } else {
            const newRow = payload.new as Record<string, unknown>;
            rowsByKey.set(`${newRow.student_uid}::${newRow.topic}`, newRow);
          }
          void handleRows(Array.from(rowsByKey.values()));
        },
      )
      .subscribe();

    return () => {
      isCurrent = false;
      supabase.removeChannel(channel);
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
