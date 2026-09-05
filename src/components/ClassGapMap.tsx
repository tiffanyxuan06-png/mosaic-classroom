'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import { supabase } from '@/lib/supabase-client';
import type {
  StudentProgress,
  ActiveMisconception,
  StudentTier,
} from '@/lib/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassGapMapProps {
  classId: string;
  topics: string[];
  language: 'en' | 'bm';
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<StudentTier | 'gray', string> = {
  red: '#ea4335',
  yellow: '#fbbc04',
  green: '#34a853',
  blue: '#1a73e8',
  gray: '#9e9e9e',
};

const TIER_TEXT_COLORS: Record<StudentTier | 'gray', string> = {
  red: '#ffffff',
  yellow: '#1f1f1f',
  green: '#ffffff',
  blue: '#ffffff',
  gray: '#ffffff',
};

type SortMode = 'priority' | 'name';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// i18n copy
// ─────────────────────────────────────────────────────────────────────────────

const COPY = {
  en: {
    title: 'Class Gap Map',
    subtitle: 'Evidence Layer — Real-time mastery overview',
    priorityView: 'Priority View',
    nameView: 'Student Name View',
    student: 'Student',
    noData: 'No student data yet',
    loading: 'Loading class data…',
    legendTitle: 'Legend',
    legendRed: 'Prerequisite missing or persistent misconception',
    legendYellow: 'Active misconception — developing',
    legendGreen: 'Mastered — independent',
    legendBlue: 'Advanced — ready for extension',
    sheetTitle: 'Student Detail',
    activeMisconceptions: 'Active Misconceptions',
    noMisconceptions: 'No active misconceptions',
    persistence: 'Persistence',
    overrideBtn: 'Override Classification',
    overrideConfirm: 'Override submitted',
    close: 'Close',
  },
  bm: {
    title: 'Peta Jurang Kelas',
    subtitle: 'Lapisan Bukti — Gambaran penguasaan masa nyata',
    priorityView: 'Paparan Keutamaan',
    nameView: 'Paparan Nama Pelajar',
    student: 'Pelajar',
    noData: 'Tiada data pelajar lagi',
    loading: 'Memuatkan data kelas…',
    legendTitle: 'Petunjuk',
    legendRed: 'Prasyarat tiada atau salah faham berterusan',
    legendYellow: 'Salah faham aktif — sedang berkembang',
    legendGreen: 'Dikuasai — berdikari',
    legendBlue: 'Lanjutan — sedia untuk pengembangan',
    sheetTitle: 'Butiran Pelajar',
    activeMisconceptions: 'Salah Faham Aktif',
    noMisconceptions: 'Tiada salah faham aktif',
    persistence: 'Kegigihan',
    overrideBtn: 'Gantikan Pengelasan',
    overrideConfirm: 'Penggantian dihantar',
    close: 'Tutup',
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Urgency score — higher = needs more attention
// ─────────────────────────────────────────────────────────────────────────────

function computeUrgencyScore(progress: StudentProgress): number {
  let score = 0;

  // Tier weighting (across all topics this student has)
  const tierWeights: Record<StudentTier, number> = {
    red: 4,
    yellow: 2,
    green: 0,
    blue: -1,
  };
  score += tierWeights[progress.tier] ?? 0;

  // Uncleared misconception count
  const uncleared = progress.activeMisconceptions.filter((m) => !m.isCleared);
  score += uncleared.length * 1.5;

  // Persistence pressure
  const maxPersistence = Math.max(
    0,
    ...uncleared.map((m) => m.persistenceScore),
  );
  score += maxPersistence * 2;

  // Foundational severity bonus
  if (uncleared.some((m) => m.severity === 'foundational')) {
    score += 3;
  }

  return Math.round(score * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived row model — one per student, combining all their topic documents
// ─────────────────────────────────────────────────────────────────────────────

interface StudentRow {
  studentId: string;
  /** Display name — falls back to studentId if we don't have a name field. */
  displayName: string;
  urgencyScore: number;
  /** topic → data from the progress document for that topic */
  topicMap: Record<
    string,
    {
      tier: StudentTier;
      misconceptions: ActiveMisconception[];
      /** Short label for the dominant misconception (shown on hover). */
      misconceptionLabel: string | null;
      /** Has a recently cleared misconception (peer-explainer indicator). */
      recentlyCleared: boolean;
      /** Max persistence score across misconceptions in this cell. */
      maxPersistence: number;
    }
  >;
  /** All progress docs for this student (for the detail sheet). */
  progressDocs: StudentProgress[];
}

function buildStudentRows(
  docs: StudentProgress[],
  topics: string[],
  // Not used yet — activeMisconceptions doesn't carry bilingual labels, so
  // the dominant-misconception label below falls back to the raw id (see
  // comment further down). Kept as a real param so the caller doesn't need
  // to change once bilingual labels are wired in.
  _language: 'en' | 'bm',
): StudentRow[] {
  // Group by studentUid
  const byStudent = new Map<string, StudentProgress[]>();
  for (const d of docs) {
    const list = byStudent.get(d.studentUid) ?? [];
    list.push(d);
    byStudent.set(d.studentUid, list);
  }

  const rows: StudentRow[] = [];

  for (const [studentId, progressList] of byStudent) {
    const topicMap: StudentRow['topicMap'] = {};
    let totalUrgency = 0;

    for (const topic of topics) {
      const prog = progressList.find((p) => p.topic === topic);
      if (!prog) {
        topicMap[topic] = {
          tier: 'green', // placeholder — will be shown as gray
          misconceptions: [],
          misconceptionLabel: null,
          recentlyCleared: false,
          maxPersistence: 0,
        };
        // Mark as "no data" — we use a sentinel
        (topicMap[topic] as Record<string, unknown>)._noData = true;
        continue;
      }

      const uncleared = prog.activeMisconceptions.filter((m) => !m.isCleared);
      const now = Date.now();
      const recentlyCleared = prog.activeMisconceptions.some(
        (m) => m.isCleared && now - m.lastSeen < SEVEN_DAYS_MS,
      );

      // Pick the dominant misconception label for hover
      const dominant = [...uncleared].sort(
        (a, b) => b.persistenceScore - a.persistenceScore,
      )[0];

      // We don't have per-misconception EN/BM labels in activeMisconceptions,
      // so we use the misconceptionId as a short label. In a full system this
      // would be looked up from the misconceptions catalogue.
      const misconceptionLabel = dominant
        ? dominant.misconceptionId.replace(/_/g, ' ')
        : null;

      const maxPersistence = Math.max(
        0,
        ...uncleared.map((m) => m.persistenceScore),
      );

      topicMap[topic] = {
        tier: prog.tier,
        misconceptions: prog.activeMisconceptions,
        misconceptionLabel,
        recentlyCleared,
        maxPersistence,
      };

      totalUrgency += computeUrgencyScore(prog);
    }

    rows.push({
      studentId,
      displayName: studentId, // Will be enriched when student profile exists
      urgencyScore: Math.round(totalUrgency * 100) / 100,
      topicMap,
      progressDocs: progressList,
    });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping — Postgres snake_case → the StudentProgress shape this
// component's rendering logic expects.
// ─────────────────────────────────────────────────────────────────────────────

function rowToStudentProgress(row: Record<string, unknown>): StudentProgress {
  return {
    studentUid: row.student_uid as string,
    classId: row.class_id as string,
    topic: row.topic as string,
    tier: row.tier as StudentTier,
    activeMisconceptions: Array.isArray(row.active_misconceptions)
      ? (row.active_misconceptions as ActiveMisconception[])
      : [],
    masteryScore: (row.mastery_score as number | undefined) ?? 0,
    consecutiveCorrect: (row.consecutive_correct as number | undefined) ?? 0,
    transferPassed: Boolean(row.transfer_passed),
    sessionsActive: (row.sessions_active as number | undefined) ?? 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// useClassProgress — realtime subscription to student_progress rows for a class
// ─────────────────────────────────────────────────────────────────────────────

function useClassProgress(classId: string) {
  const [docs, setDocs] = useState<StudentProgress[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Initial one-shot fetch — Supabase realtime doesn't emit the current
    // rows on subscribe, unlike Firestore's onSnapshot.
    supabase
      .from('student_progress')
      .select('*')
      .eq('class_id', classId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[ClassGapMap] Error loading student progress:', error);
        }
        setDocs((data ?? []).map(rowToStudentProgress));
        setLoading(false);
      });

    const channel = supabase
      .channel(`class-gap-map-${classId}`)
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
            setDocs((prev) =>
              prev.filter(
                (p) =>
                  !(
                    p.studentUid === (oldRow.student_uid as string) &&
                    p.topic === (oldRow.topic as string)
                  ),
              ),
            );
            return;
          }

          const progress = rowToStudentProgress(payload.new as Record<string, unknown>);
          setDocs((prev) => {
            const withoutExisting = prev.filter(
              (p) => !(p.studentUid === progress.studentUid && p.topic === progress.topic),
            );
            return [...withoutExisting, progress];
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [classId]);

  return { docs, loading };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Sheet (inline — replaces @/components/ui/sheet for now)
// ─────────────────────────────────────────────────────────────────────────────
// TODO: Replace with shadcn <Sheet> once `npx shadcn-ui@latest add sheet` is
// run. The API below is intentionally compatible.

function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />
          {/* Panel */}
          <motion.aside
            key="sheet-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className={cn(
              'fixed right-0 top-0 z-50 h-full w-full max-w-md',
              'bg-white shadow-2xl overflow-y-auto',
              'border-l border-gray-200',
            )}
            role="dialog"
            aria-modal="true"
          >
            {children}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: StudentDetailSheet
// ─────────────────────────────────────────────────────────────────────────────

interface StudentDetailSheetProps {
  open: boolean;
  onClose: () => void;
  student: StudentRow | null;
  language: 'en' | 'bm';
}

function StudentDetailSheet({
  open,
  onClose,
  student,
  language,
}: StudentDetailSheetProps) {
  const t = COPY[language];

  if (!student) return null;

  // Gather all uncleared misconceptions from every topic document
  const allMisconceptions = student.progressDocs.flatMap((p) =>
    p.activeMisconceptions
      .filter((m) => !m.isCleared)
      .map((m) => ({ ...m, topic: p.topic })),
  );

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-bold text-gray-900">
              {student.displayName}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">{t.sheetTitle}</p>
          </div>
          <button
            onClick={onClose}
            className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center',
              'text-gray-400 hover:text-gray-700 hover:bg-gray-100',
              'transition-colors duration-150',
            )}
            aria-label={t.close}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Misconceptions list */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-3">
              {t.activeMisconceptions}
            </h4>

            {allMisconceptions.length === 0 ? (
              <p className="text-sm text-gray-400 italic">
                {t.noMisconceptions}
              </p>
            ) : (
              <ul className="space-y-3">
                {allMisconceptions
                  .sort((a, b) => b.persistenceScore - a.persistenceScore)
                  .map((m) => (
                    <li
                      key={m.misconceptionId + m.topic}
                      className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 leading-snug">
                            {m.misconceptionId.replace(/_/g, ' ')}
                          </p>
                          <p className="text-xs text-gray-500 mt-1 capitalize">
                            {m.topic} · {m.severity}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {m.persistenceScore > 3 && (
                            <span
                              title={`${t.persistence}: ${m.persistenceScore.toFixed(1)}`}
                              className="text-amber-500"
                            >
                              ⚠️
                            </span>
                          )}
                          <span
                            className={cn(
                              'text-xs font-semibold px-2 py-0.5 rounded-full',
                              m.persistenceScore > 3
                                ? 'bg-red-100 text-red-700'
                                : m.persistenceScore > 1.5
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-gray-100 text-gray-600',
                            )}
                          >
                            {m.persistenceScore.toFixed(1)}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Heatmap Cell
// ─────────────────────────────────────────────────────────────────────────────

interface HeatmapCellProps {
  tier: StudentTier | 'gray';
  misconceptionLabel: string | null;
  persistenceHigh: boolean;
  recentlyCleared: boolean;
  onClick: () => void;
}

function HeatmapCell({
  tier,
  misconceptionLabel,
  persistenceHigh,
  recentlyCleared,
  onClick,
}: HeatmapCellProps) {
  const bg = TIER_COLORS[tier];
  const fg = TIER_TEXT_COLORS[tier];

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.08, zIndex: 10 }}
      whileTap={{ scale: 0.95 }}
      title={
        tier === 'gray'
          ? 'No data'
          : misconceptionLabel
            ? misconceptionLabel
            : tier
      }
      className={cn(
        'relative w-full aspect-square rounded-lg',
        'flex items-center justify-center',
        'cursor-pointer select-none',
        'transition-shadow duration-150',
        'hover:shadow-lg hover:ring-2 hover:ring-offset-1',
        tier === 'red' && 'hover:ring-red-400',
        tier === 'yellow' && 'hover:ring-amber-400',
        tier === 'green' && 'hover:ring-emerald-400',
        tier === 'blue' && 'hover:ring-blue-400',
        tier === 'gray' && 'hover:ring-gray-400',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
      )}
      style={{ backgroundColor: bg, color: fg }}
    >
      {/* Persistence flag */}
      {persistenceHigh && (
        <span
          className="absolute -top-1 -right-1 text-xs leading-none"
          aria-label="Persistent misconception"
        >
          ⚠️
        </span>
      )}

      {/* Peer explainer indicator */}
      {recentlyCleared && (
        <span
          className="absolute -bottom-1 -right-1 text-xs leading-none"
          aria-label="Recently cleared"
        >
          💬
        </span>
      )}

      {/* Misconception short label on red cells */}
      {tier === 'red' && misconceptionLabel && (
        <span className="text-[9px] leading-tight font-medium text-center px-0.5 line-clamp-2 opacity-90">
          {misconceptionLabel}
        </span>
      )}
    </motion.button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Legend
// ─────────────────────────────────────────────────────────────────────────────

function Legend({ language }: { language: 'en' | 'bm' }) {
  const t = COPY[language];

  const items: { color: string; label: string }[] = [
    { color: TIER_COLORS.red, label: t.legendRed },
    { color: TIER_COLORS.yellow, label: t.legendYellow },
    { color: TIER_COLORS.green, label: t.legendGreen },
    { color: TIER_COLORS.blue, label: t.legendBlue },
  ];

  return (
    <div className="mt-5 px-1">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
        {t.legendTitle}
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {items.map((item) => (
          <span key={item.color} className="flex items-center gap-1.5 text-xs text-gray-600">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function ClassGapMap({
  classId,
  topics,
  language,
}: ClassGapMapProps) {
  const t = COPY[language];
  const { docs, loading } = useClassProgress(classId);

  const [sortMode, setSortMode] = useState<SortMode>('priority');
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(
    null,
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  // Build & sort rows
  const rows = useMemo(() => {
    const built = buildStudentRows(docs, topics, language);
    if (sortMode === 'priority') {
      built.sort((a, b) => b.urgencyScore - a.urgencyScore);
    } else {
      built.sort((a, b) =>
        a.displayName.localeCompare(b.displayName, language === 'bm' ? 'ms' : 'en'),
      );
    }
    return built;
  }, [docs, topics, language, sortMode]);

  const handleCellClick = useCallback((student: StudentRow) => {
    setSelectedStudent(student);
    setSheetOpen(true);
  }, []);

  const handleSheetClose = useCallback(() => {
    setSheetOpen(false);
  }, []);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
          className="w-6 h-6 border-2 border-gray-300 border-t-gray-700 rounded-full"
        />
        <span className="ml-3 text-sm text-gray-500">{t.loading}</span>
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (rows.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-sm text-gray-400">{t.noData}</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section
      id="class-gap-map"
      className="w-full"
      aria-label={t.title}
    >
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-bold text-gray-900">{t.title}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{t.subtitle}</p>
        </div>

        {/* Sort toggle */}
        <div
          className="inline-flex rounded-lg bg-gray-100 p-0.5"
          role="radiogroup"
          aria-label="Sort mode"
        >
          {(
            [
              { mode: 'priority' as SortMode, label: t.priorityView },
              { mode: 'name' as SortMode, label: t.nameView },
            ] as const
          ).map(({ mode, label }) => (
            <button
              key={mode}
              role="radio"
              aria-checked={sortMode === mode}
              onClick={() => setSortMode(mode)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150',
                sortMode === mode
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Heatmap grid */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full border-collapse min-w-[480px]">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3 sticky left-0 bg-white z-10 min-w-[140px]">
                {t.student}
              </th>
              {topics.map((topic) => (
                <th
                  key={topic}
                  className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 py-3 min-w-[72px]"
                >
                  {topic}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <AnimatePresence mode="popLayout">
              {rows.map((student) => (
                <motion.tr
                  key={student.studentId}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2 }}
                  className="border-b border-gray-50 last:border-b-0 group"
                >
                  {/* Student name cell */}
                  <td className="px-4 py-2.5 sticky left-0 bg-white z-10 group-hover:bg-gray-50 transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800 truncate max-w-[120px]">
                        {student.displayName}
                      </span>
                      {sortMode === 'priority' && (
                        <span className="text-[10px] text-gray-400 font-mono flex-shrink-0">
                          {student.urgencyScore.toFixed(1)}
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Topic cells */}
                  {topics.map((topic) => {
                    const cell = student.topicMap[topic];
                    const isNoData =
                      !cell ||
                      (cell as Record<string, unknown>)._noData === true;
                    const tier: StudentTier | 'gray' = isNoData
                      ? 'gray'
                      : cell.tier;

                    return (
                      <td key={topic} className="px-2 py-2">
                        <div className="w-full max-w-[48px] mx-auto">
                          <HeatmapCell
                            tier={tier}
                            misconceptionLabel={
                              isNoData ? null : cell.misconceptionLabel
                            }
                            persistenceHigh={
                              !isNoData && cell.maxPersistence > 3
                            }
                            recentlyCleared={
                              !isNoData && cell.recentlyCleared
                            }
                            onClick={() => handleCellClick(student)}
                          />
                        </div>
                      </td>
                    );
                  })}
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <Legend language={language} />

      {/* Student Detail Sheet */}
      <StudentDetailSheet
        open={sheetOpen}
        onClose={handleSheetClose}
        student={selectedStudent}
        language={language}
      />
    </section>
  );
}
