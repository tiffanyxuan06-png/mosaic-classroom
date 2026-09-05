'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import { supabase } from '@/lib/supabase-client';
import { useClassContext } from '@/lib/useClassContext';
import {
  REPEAT_ALERT_THRESHOLD,
  clusterByMisconception,
  buildMisconceptionColorIndex,
  misconceptionShortLabel,
  studentName as resolveStudentName,
  type ClassContext,
  type MisconceptionCluster,
} from '@/lib/classInsights';
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

/**
 * Colour view: `tier` answers "how far along is this student", `misconception`
 * answers "which error pattern is this" — the typology view that lets a
 * teacher see at a glance that a whole column shares one mental block.
 */
type ColorMode = 'tier' | 'misconception';

/**
 * Distinct hues for the misconception-typology view. Cells sharing a colour
 * share the same error pattern, regardless of score.
 */
const MISCONCEPTION_COLORS = [
  '#d81b60',
  '#8e24aa',
  '#3949ab',
  '#00897b',
  '#f4511e',
  '#6d4c41',
  '#00838f',
  '#c0ca33',
  '#5e35b1',
  '#e53935',
] as const;

const CLEAR_COLOR = '#e8f0ea';

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
    tierView: 'By mastery',
    misconceptionView: 'By misconception',
    repeatedTimes: 'repeated',
    times: 'times',
    repeatAlert: 'Repeated 3+ times — needs intervention',
    errorPatterns: 'Error patterns in this class',
    noErrorPatterns: 'No active error patterns',
    mastered: 'No active misconception',
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
    tierView: 'Ikut penguasaan',
    misconceptionView: 'Ikut salah faham',
    repeatedTimes: 'berulang',
    times: 'kali',
    repeatAlert: 'Berulang 3+ kali — perlu campur tangan',
    errorPatterns: 'Corak kesilapan dalam kelas ini',
    noErrorPatterns: 'Tiada corak kesilapan aktif',
    mastered: 'Tiada salah faham aktif',
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
      /** Id of the dominant misconception — drives the typology colour. */
      dominantMisconceptionId: string | null;
      /** Has a recently cleared misconception (peer-explainer indicator). */
      recentlyCleared: boolean;
      /** Max persistence score across misconceptions in this cell. */
      maxPersistence: number;
      /** Highest repeat count among uncleared misconceptions in this cell. */
      maxOccurrences: number;
      /** True once a misconception here has been repeated 3+ times. */
      repeatAlert: boolean;
    }
  >;
  /** All progress docs for this student (for the detail sheet). */
  progressDocs: StudentProgress[];
}

function buildStudentRows(
  docs: StudentProgress[],
  topics: string[],
  language: 'en' | 'bm',
  context: ClassContext,
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
          dominantMisconceptionId: null,
          recentlyCleared: false,
          maxPersistence: 0,
          maxOccurrences: 0,
          repeatAlert: false,
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

      const misconceptionLabel = dominant
        ? misconceptionShortLabel(dominant.misconceptionId, context, language)
        : null;

      const maxPersistence = Math.max(
        0,
        ...uncleared.map((m) => m.persistenceScore),
      );
      const maxOccurrences = Math.max(0, ...uncleared.map((m) => m.occurrenceCount));

      topicMap[topic] = {
        tier: prog.tier,
        misconceptions: prog.activeMisconceptions,
        misconceptionLabel,
        dominantMisconceptionId: dominant?.misconceptionId ?? null,
        recentlyCleared,
        maxPersistence,
        maxOccurrences,
        repeatAlert: maxOccurrences >= REPEAT_ALERT_THRESHOLD,
      };

      totalUrgency += computeUrgencyScore(prog);
    }

    rows.push({
      studentId,
      displayName: resolveStudentName(studentId, context),
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
  context: ClassContext;
}

function StudentDetailSheet({
  open,
  onClose,
  student,
  language,
  context,
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
                            {misconceptionShortLabel(m.misconceptionId, context, language)}
                          </p>
                          <p className="text-xs text-gray-500 mt-1 capitalize">
                            {m.topic} · {m.severity} ·{' '}
                            <span
                              className={cn(
                                m.occurrenceCount >= REPEAT_ALERT_THRESHOLD &&
                                  'text-red-600 font-semibold',
                              )}
                            >
                              {t.repeatedTimes} {m.occurrenceCount} {t.times}
                            </span>
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {m.occurrenceCount >= REPEAT_ALERT_THRESHOLD && (
                            <span title={t.repeatAlert} className="text-red-600">
                              🔔
                            </span>
                          )}
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
  repeatAlert: boolean;
  occurrences: number;
  /** Typology colour when colorMode is 'misconception'; null = mastered/no data. */
  misconceptionColor: string | null;
  colorMode: ColorMode;
  onClick: () => void;
}

function HeatmapCell({
  tier,
  misconceptionLabel,
  persistenceHigh,
  recentlyCleared,
  repeatAlert,
  occurrences,
  misconceptionColor,
  colorMode,
  onClick,
}: HeatmapCellProps) {
  const useTypology = colorMode === 'misconception' && tier !== 'gray';
  const bg = useTypology
    ? misconceptionColor ?? CLEAR_COLOR
    : TIER_COLORS[tier];
  const fg = useTypology
    ? misconceptionColor
      ? '#ffffff'
      : '#3c4043'
    : TIER_TEXT_COLORS[tier];

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
            ? `${misconceptionLabel}${occurrences > 0 ? ` — ${occurrences}×` : ''}`
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
        // A repeated misconception outranks every other cell signal — ring it
        // so it reads across the room during a lesson.
        repeatAlert && 'ring-2 ring-offset-1 ring-red-600 animate-pulse',
      )}
      style={{ backgroundColor: bg, color: fg }}
    >
      {/* Repeat-count badge — the 3+ intervention trigger */}
      {repeatAlert && (
        <span
          className={cn(
            'absolute -top-1.5 -left-1.5 min-w-[16px] h-4 px-1 rounded-full',
            'bg-red-600 text-white text-[9px] font-bold leading-4 text-center',
            'shadow-sm',
          )}
          aria-label={`Repeated ${occurrences} times`}
        >
          {occurrences}×
        </span>
      )}

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

      {/* Misconception short label — always shown in typology view, and on
          red cells in mastery view where the gap is the headline. */}
      {(useTypology || tier === 'red') && misconceptionLabel && (
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

function Legend({
  language,
  colorMode,
  clusters,
}: {
  language: 'en' | 'bm';
  colorMode: ColorMode;
  clusters: MisconceptionCluster[];
}) {
  const t = COPY[language];

  // Typology view: the legend IS the class's error-pattern breakdown, so each
  // entry doubles as a headcount for that shared mental block.
  if (colorMode === 'misconception') {
    return (
      <div className="mt-5 px-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          {t.errorPatterns}
        </p>
        {clusters.length === 0 ? (
          <p className="text-xs text-gray-400 italic">{t.noErrorPatterns}</p>
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            {clusters.map((cluster, i) => (
              <span
                key={cluster.misconceptionId}
                className="flex items-center gap-1.5 text-xs text-gray-600"
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor:
                      MISCONCEPTION_COLORS[i % MISCONCEPTION_COLORS.length],
                  }}
                />
                {cluster.shortLabel}
                <span className="text-gray-400">({cluster.students.length})</span>
                {cluster.repeatAlertCount > 0 && (
                  <span className="text-red-600 font-semibold">
                    · {cluster.repeatAlertCount} ≥{REPEAT_ALERT_THRESHOLD}×
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

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
  const { context } = useClassContext(classId);

  const [sortMode, setSortMode] = useState<SortMode>('priority');
  const [colorMode, setColorMode] = useState<ColorMode>('tier');
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(
    null,
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  // Misconception clusters drive the typology palette — the most widespread
  // error pattern gets the first colour, so the legend reads in priority order.
  const clusters = useMemo(
    () => clusterByMisconception(docs, context, language),
    [docs, context, language],
  );
  const colorIndex = useMemo(
    () => buildMisconceptionColorIndex(clusters),
    [clusters],
  );

  const misconceptionColorFor = useCallback(
    (misconceptionId: string | null): string | null => {
      if (!misconceptionId) return null;
      const i = colorIndex.get(misconceptionId);
      if (i === undefined) return null;
      return MISCONCEPTION_COLORS[i % MISCONCEPTION_COLORS.length];
    },
    [colorIndex],
  );

  // Build & sort rows
  const rows = useMemo(() => {
    const built = buildStudentRows(docs, topics, language, context);
    if (sortMode === 'priority') {
      built.sort((a, b) => b.urgencyScore - a.urgencyScore);
    } else {
      built.sort((a, b) =>
        a.displayName.localeCompare(b.displayName, language === 'bm' ? 'ms' : 'en'),
      );
    }
    return built;
  }, [docs, topics, language, sortMode, context]);

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

        <div className="flex flex-wrap items-center gap-2">
        {/* Colour-mode toggle — mastery tiers vs misconception typology */}
        <div
          className="inline-flex rounded-lg bg-gray-100 p-0.5"
          role="radiogroup"
          aria-label="Colour mode"
        >
          {(
            [
              { mode: 'tier' as ColorMode, label: t.tierView },
              { mode: 'misconception' as ColorMode, label: t.misconceptionView },
            ] as const
          ).map(({ mode, label }) => (
            <button
              key={mode}
              role="radio"
              aria-checked={colorMode === mode}
              onClick={() => setColorMode(mode)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150',
                colorMode === mode
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {label}
            </button>
          ))}
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
                            colorMode={colorMode}
                            misconceptionColor={
                              isNoData
                                ? null
                                : misconceptionColorFor(cell.dominantMisconceptionId)
                            }
                            misconceptionLabel={
                              isNoData ? null : cell.misconceptionLabel
                            }
                            occurrences={isNoData ? 0 : cell.maxOccurrences}
                            repeatAlert={!isNoData && cell.repeatAlert}
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
      <Legend language={language} colorMode={colorMode} clusters={clusters} />

      {/* Student Detail Sheet */}
      <StudentDetailSheet
        open={sheetOpen}
        onClose={handleSheetClose}
        student={selectedStudent}
        language={language}
        context={context}
      />
    </section>
  );
}
