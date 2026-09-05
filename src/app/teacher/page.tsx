'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, X } from 'lucide-react';

import { supabase } from '@/lib/supabase-client';
import { useUserRole } from '@/lib/auth';
import { useLanguage } from '@/lib/LanguageContext';
import type { StudentProgress as HelpersStudentProgress } from '@/lib/helpers';
import type { StudentTier as MasteryTier } from '@/lib/helpers';

import ActionCard from '@/components/ActionCard';
import ClassGapMap from '@/components/ClassGapMap';
import PaperScanner from '@/components/PaperScanner';
import { generateCapsuleHTML, type CapsuleResponse } from '@/lib/capsuleHtml';

// ────────────────────────────────────────────────────────────────────────────
// Pulse types and components
// ────────────────────────────────────────────────────────────────────────────

interface PulseQuestion {
  questionId: string;
  questionText: string;
  options: { A: string; B: string; C: string; D: string };
  correctOption: string;
}

interface PulseResponse {
  pulseId: string;
  studentId: string;
  answers: { questionIndex: number; selectedOption: string }[];
  completedAt: number;
}

interface PulseState {
  pulseId: string;
  questions: PulseQuestion[];
  createdAt: number;
}

const OPTION_COLORS: Record<string, string> = {
  A: '#4285f4',
  B: '#ea4335',
  C: '#fbbc04',
  D: '#34a853',
};

function PulseBarChart({
  questionIndex,
  questionText,
  correctOption,
  distribution,
  totalResponses,
  language,
}: {
  questionIndex: number;
  questionText: string;
  correctOption: string;
  distribution: Record<string, number>;
  totalResponses: number;
  language: 'en' | 'bm';
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <span className="flex-shrink-0 w-7 h-7 rounded-lg bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">
          {language === 'en' ? 'Q' : 'S'}{questionIndex + 1}
        </span>
        <p className="text-sm text-gray-700 leading-snug line-clamp-2">
          {questionText}
        </p>
      </div>

      <div className="space-y-1.5">
        {['A', 'B', 'C', 'D'].map((opt) => {
          const count = distribution[opt] ?? 0;
          const pct = totalResponses > 0 ? (count / totalResponses) * 100 : 0;
          const isCorrect = opt === correctOption;

          return (
            <div key={opt} className="flex items-center gap-2">
              <span
                className={cn(
                  'w-5 text-xs font-bold text-center',
                  isCorrect ? 'text-green-700' : 'text-gray-500',
                )}
              >
                {opt}
              </span>
              <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden relative">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: OPTION_COLORS[opt] }}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.max(pct, 0)}%` }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                />
              </div>
              <span className="w-8 text-right text-xs font-mono text-gray-500">
                {count}
              </span>
              {isCorrect && (
                <span className="text-xs text-green-600 font-semibold">✓</span>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-gray-400">
        {totalResponses} {language === 'en' ? 'responses' : 'jawapan'}
      </p>
    </div>
  );
}

function PulseResultsOverlay({
  pulse,
  responses,
  language,
  onClose,
}: {
  pulse: PulseState;
  responses: PulseResponse[];
  language: 'en' | 'bm';
  onClose: () => void;
}) {
  const distributions = useMemo(() => {
    const result: Record<string, number>[] = pulse.questions.map(() => ({
      A: 0,
      B: 0,
      C: 0,
      D: 0,
    }));

    for (const resp of responses) {
      for (const ans of resp.answers) {
        if (result[ans.questionIndex] && ans.selectedOption) {
          result[ans.questionIndex][ans.selectedOption] =
            (result[ans.questionIndex][ans.selectedOption] ?? 0) + 1;
        }
      }
    }

    return result;
  }, [pulse.questions, responses]);

  const misconceptionData = useMemo(() => {
    return pulse.questions.map((q, idx) => {
      const wrongAnswers: Record<string, number> = {};
      let wrongCount = 0;

      for (const resp of responses) {
        const ans = resp.answers.find((a) => a.questionIndex === idx);
        if (ans && ans.selectedOption !== q.correctOption) {
          wrongAnswers[ans.selectedOption] =
            (wrongAnswers[ans.selectedOption] ?? 0) + 1;
          wrongCount += 1;
        }
      }

      return { wrongAnswers, wrongCount, totalResponses: responses.length };
    });
  }, [pulse.questions, responses]);

  const isExpired = Date.now() > pulse.createdAt + 5 * 60 * 1000;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="bg-white rounded-2xl border-2 border-blue-200 shadow-lg overflow-hidden my-6"
    >
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-5 py-4 flex items-center justify-between border-b border-blue-100">
        <div className="flex items-center gap-3">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
          <h3 className="text-sm font-bold text-blue-900">
            {language === 'en' ? 'Pulse Results — Live' : 'Keputusan Nadi — Langsung'}
          </h3>
          <span className="text-xs text-blue-500 font-mono">
            {responses.length} {language === 'en' ? 'responses' : 'jawapan'}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors font-medium"
        >
          {language === 'en' ? 'Close' : 'Tutup'}
        </button>
      </div>

      {isExpired && (
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-2">
          <p className="text-xs text-amber-700 font-medium">
            {language === 'en' ? 'Pulse expired' : 'Nadi tamat tempoh'}
          </p>
        </div>
      )}

      <div className="px-5 py-4 space-y-4">
        {responses.length === 0 ? (
          <div className="text-center py-8">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              className="w-6 h-6 border-2 border-blue-300 border-t-blue-600 rounded-full mx-auto mb-3"
            />
            <p className="text-sm text-gray-400">
              {language === 'en' ? 'Waiting for responses…' : 'Menunggu jawapan…'}
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {pulse.questions.map((q, idx) => (
                <PulseBarChart
                  key={q.questionId}
                  questionIndex={idx}
                  questionText={q.questionText}
                  correctOption={q.correctOption}
                  distribution={distributions[idx]}
                  totalResponses={responses.length}
                  language={language}
                />
              ))}
            </div>

            <div className="border-t border-gray-100 pt-4">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                {language === 'en' ? 'Misconception Breakdown' : 'Pecahan Salah Faham'}
              </h4>
              <div className="space-y-2">
                {misconceptionData.map((data, idx) => {
                  if (data.wrongCount === 0) return null;
                  const topWrong = Object.entries(data.wrongAnswers)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 2);

                  return (
                    <div
                      key={idx}
                      className="flex items-center gap-3 text-xs bg-red-50 rounded-lg px-3 py-2"
                    >
                      <span className="font-bold text-red-700">
                        {language === 'en' ? 'Q' : 'S'}{idx + 1}
                      </span>
                      <span className="text-red-600">
                        {data.wrongCount}/{data.totalResponses} {language === 'en' ? 'wrong' : 'salah'}
                      </span>
                      <span className="text-red-400">
                        →{' '}
                        {topWrong
                          .map(([opt, count]) => `${opt}: ${count}`)
                          .join(', ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface ClassData {
  classId: string;
  name: string;
  subject: string;
  teacherUid: string | null;
  topics: string[];
  kioskMode: boolean;
  studentCount: number;
}

interface InterventionGroup {
  tier: MasteryTier;
  name_en: string;
  name_bm: string;
  students: Array<{ uid: string; name: string; masteryScore: number }>;
}

interface StudentForPanel {
  uid: string;
  name: string;
  email: string;
  /** One row per topic (canonical per-student-per-topic schema). */
  progressByTopic: HelpersStudentProgress[];
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<MasteryTier, { bg: string; text: string; dot: string }> = {
  red: { bg: 'bg-red-100', text: 'text-red-700', dot: 'bg-red-500' },
  yellow: { bg: 'bg-yellow-100', text: 'text-yellow-700', dot: 'bg-yellow-400' },
  green: { bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500' },
  blue: { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
};

const TIER_LABELS: Record<MasteryTier, { en: string; bm: string }> = {
  red: { en: 'Needs support', bm: 'Perlu sokongan' },
  yellow: { en: 'Developing', bm: 'Sedang berkembang' },
  green: { en: 'Mastered', bm: 'Dikuasai' },
  blue: { en: 'Advanced', bm: 'Lanjutan' },
};

const INTERVENTION_GROUP_LABELS: Record<string, { en: string; bm: string }> = {
  red: { en: 'Group A: Rebuild', bm: 'Kumpulan A: Bina Semula' },
  yellow: { en: 'Group B: Repair', bm: 'Kumpulan B: Baiki' },
  green: { en: 'Group C: Practice', bm: 'Kumpulan C: Latih' },
  blue: { en: 'Group D: Extend', bm: 'Kumpulan D: Perluas' },
};

// ────────────────────────────────────────────────────────────────────────────
// Utility functions
// ────────────────────────────────────────────────────────────────────────────

function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

function classRowToClassData(row: Record<string, unknown>): ClassData {
  return {
    classId: row.id as string,
    name: row.name as string,
    subject: row.subject as string,
    teacherUid: (row.teacher_id as string | null) ?? null,
    topics: Array.isArray(row.topics) ? (row.topics as string[]) : [],
    kioskMode: Boolean(row.kiosk_mode),
    studentCount: (row.student_count as number | undefined) ?? 0,
  };
}

function progressRowToHelpers(row: Record<string, unknown>): HelpersStudentProgress {
  return {
    studentUid: row.student_uid as string,
    classId: row.class_id as string,
    topic: row.topic as string,
    tier: row.tier as MasteryTier,
    activeMisconceptions: Array.isArray(row.active_misconceptions)
      ? (row.active_misconceptions as HelpersStudentProgress['activeMisconceptions'])
      : [],
    masteryScore: (row.mastery_score as number | undefined) ?? 0,
    consecutiveCorrect: (row.consecutive_correct as number | undefined) ?? 0,
    transferPassed: Boolean(row.transfer_passed),
    sessionsActive: (row.sessions_active as number | undefined) ?? 1,
  };
}

function pulseResponseRowToPulseResponse(row: Record<string, unknown>): PulseResponse {
  return {
    pulseId: row.pulse_id as string,
    studentId: row.student_id as string,
    answers: Array.isArray(row.answers)
      ? (row.answers as PulseResponse['answers'])
      : [],
    completedAt: row.completed_at
      ? new Date(row.completed_at as string).getTime()
      : Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Capsule helpers
// ────────────────────────────────────────────────────────────────────────────

interface MisconceptionDetails {
  id: string;
  name: string;
  topic: string;
  wrongAnswerPattern: string;
  remediationApproach: string;
}

/** Load the fields /api/capsule/generate needs for one misconception. */
async function fetchMisconceptionDetails(
  misconceptionId: string,
): Promise<MisconceptionDetails | null> {
  const { data, error } = await supabase
    .from('misconceptions')
    .select('id, name, topic, wrong_answer_pattern, remediation_approach')
    .eq('id', misconceptionId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    name: (data.name as string) || misconceptionId,
    topic: data.topic as string,
    wrongAnswerPattern:
      (data.wrong_answer_pattern as string | null) || 'Applies the rule incorrectly.',
    remediationApproach:
      (data.remediation_approach as string | null) ||
      'Work through worked examples step by step, then practise similar items.',
  };
}

/**
 * Pick the misconception a capsule should target: the most frequent uncleared
 * one across the given progress rows, ties broken by persistence.
 */
function pickTargetMisconception(progressRows: HelpersStudentProgress[]): string | null {
  const counts = new Map<string, { count: number; persistence: number }>();
  for (const progress of progressRows) {
    for (const m of progress.activeMisconceptions) {
      if (m.isCleared) continue;
      const entry = counts.get(m.misconceptionId) ?? { count: 0, persistence: 0 };
      entry.count += 1;
      entry.persistence = Math.max(entry.persistence, m.persistenceScore);
      counts.set(m.misconceptionId, entry);
    }
  }
  let best: string | null = null;
  let bestScore = -1;
  counts.forEach((entry, id) => {
    const score = entry.count * 10 + entry.persistence;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  });
  return best;
}

/** Trigger a browser download of a generated capsule as a printable HTML file. */
function downloadCapsuleHtml(capsule: CapsuleResponse, fileName: string, studentName?: string) {
  const html = generateCapsuleHTML(capsule, studentName);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ────────────────────────────────────────────────────────────────────────────
// Main Component
// ────────────────────────────────────────────────────────────────────────────

export default function TeacherDashboard() {
  // Auth & navigation
  const { uid, loading: authLoading } = useUserRole();
  // Shared with the layout header's EN | BM toggle via LanguageContext.
  const { language, setLanguage } = useLanguage();

  // Class data
  const [classData, setClassData] = useState<ClassData | null>(null);
  const [studentProgress, setStudentProgress] = useState<Map<string, HelpersStudentProgress>>(
    new Map(),
  );
  /** student uid → display name, loaded from `profiles` for this class. */
  const [studentNames, setStudentNames] = useState<Record<string, string>>({});

  // UI state
  const [selectedStudent, setSelectedStudent] = useState<StudentForPanel | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [interventionGroupsOpen, setInterventionGroupsOpen] = useState(false);
  // Sorting is now handled inside ClassGapMap itself (its own priority/name
  // toggle) — this page no longer needs a duplicate sort-mode of its own.
  const [loading, setLoading] = useState(true);

  // Pulse state
  const [activePulse, setActivePulse] = useState<PulseState | null>(null);
  const [pulseResponses, setPulseResponses] = useState<PulseResponse[]>([]);
  const [pulseLoading, setPulseLoading] = useState(false);
  const [pulseToast, setPulseToast] = useState<string | null>(null);

  // Paper scanner state
  const [scannerOpen, setScannerOpen] = useState(false);

  /** Show a transient message in the top toast (shared with pulse). */
  const showToast = useCallback((message: string) => {
    setPulseToast(message);
    setTimeout(() => setPulseToast(null), 4000);
  }, []);

  // Demo: using a hardcoded classId until class selection/routing exists.
  const CLASS_ID = 'class_demo_01';

  const handlePushPulse = useCallback(async () => {
    if (pulseLoading) return;
    setPulseLoading(true);
    try {
      const res = await fetch('/api/pulse/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classId: CLASS_ID,
          teacherUid: uid || 'teacher_001',
          topicOverride: classData?.topics?.[0],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setActivePulse({
        pulseId: data.pulseId,
        questions: data.questions,
        createdAt: Date.now(),
      });
      setPulseResponses([]);
      setPulseToast(
        language === 'en'
          ? '✓ Pulse sent to all students'
          : '✓ Nadi dihantar kepada semua pelajar',
      );
      setTimeout(() => setPulseToast(null), 4000);
    } catch (err) {
      console.error('[teacher] push pulse failed:', err);
      setPulseToast(
        language === 'en' ? 'Failed to push pulse' : 'Gagal menghantar nadi',
      );
      setTimeout(() => setPulseToast(null), 4000);
    } finally {
      setPulseLoading(false);
    }
  }, [pulseLoading, uid, classData?.topics, language, CLASS_ID]);

  // Listen to incoming pulse responses in real-time
  useEffect(() => {
    if (!activePulse) return;

    let cancelled = false;

    supabase
      .from('pulse_responses')
      .select('*')
      .eq('pulse_id', activePulse.pulseId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[teacher] Error loading initial pulse responses:', error);
          return;
        }
        setPulseResponses((data ?? []).map(pulseResponseRowToPulseResponse));
      });

    const channel = supabase
      .channel(`pulse-responses-${activePulse.pulseId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pulse_responses',
          filter: `pulse_id=eq.${activePulse.pulseId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Record<string, unknown>;
            setPulseResponses((prev) =>
              prev.filter((r) => r.studentId !== (oldRow.student_id as string)),
            );
            return;
          }

          const row = pulseResponseRowToPulseResponse(
            payload.new as Record<string, unknown>,
          );
          setPulseResponses((prev) => {
            const withoutExisting = prev.filter((r) => r.studentId !== row.studentId);
            return [...withoutExisting, row];
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [activePulse]);

  // ──────────────────────────────────────────────────────────────────────────
  // Load class data
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!CLASS_ID) return;

    let cancelled = false;

    supabase
      .from('classes')
      .select('*')
      .eq('id', CLASS_ID)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[teacher] Error loading class:', error);
        } else if (data) {
          setClassData(classRowToClassData(data));
        }
        setLoading(false);
      });

    const channel = supabase
      .channel(`classes-${CLASS_ID}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'classes',
          filter: `id=eq.${CLASS_ID}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setClassData(null);
            return;
          }
          setClassData(classRowToClassData(payload.new as Record<string, unknown>));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Load all student progress for the class (one row per student per topic)
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!CLASS_ID) return;

    let cancelled = false;

    const rowKey = (studentUid: string, topic: string) => `${studentUid}::${topic}`;

    supabase
      .from('student_progress')
      .select('*')
      .eq('class_id', CLASS_ID)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[teacher] Error loading student progress:', error);
          return;
        }
        const map = new Map<string, HelpersStudentProgress>();
        for (const row of data ?? []) {
          const progress = progressRowToHelpers(row);
          map.set(rowKey(progress.studentUid, progress.topic), progress);
        }
        setStudentProgress(map);
      });

    const channel = supabase
      .channel(`student-progress-${CLASS_ID}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'student_progress',
          filter: `class_id=eq.${CLASS_ID}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const oldRow = payload.old as Record<string, unknown>;
            setStudentProgress((prev) => {
              const next = new Map(prev);
              next.delete(rowKey(oldRow.student_uid as string, oldRow.topic as string));
              return next;
            });
            return;
          }

          const progress = progressRowToHelpers(payload.new as Record<string, unknown>);
          setStudentProgress((prev) => {
            const next = new Map(prev);
            next.set(rowKey(progress.studentUid, progress.topic), progress);
            return next;
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Load the class roster (student names) so the gap map, intervention
  // groups and detail panel can show names instead of raw uids.
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!CLASS_ID) return;

    let cancelled = false;

    supabase
      .from('profiles')
      .select('id, name')
      .eq('class_id', CLASS_ID)
      .eq('role', 'student')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[teacher] Error loading student names:', error);
          return;
        }
        const names: Record<string, string> = {};
        for (const row of data ?? []) {
          if (row.id && row.name) names[row.id as string] = row.name as string;
        }
        setStudentNames(names);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Group progress rows by student uid (one entry per student, all topics)
  // ──────────────────────────────────────────────────────────────────────────

  const progressByStudent = useMemo(() => {
    const map = new Map<string, HelpersStudentProgress[]>();
    studentProgress.forEach((progress) => {
      const list = map.get(progress.studentUid) ?? [];
      list.push(progress);
      map.set(progress.studentUid, list);
    });
    return map;
  }, [studentProgress]);

  // ──────────────────────────────────────────────────────────────────────────
  // Group students by intervention tier
  // ──────────────────────────────────────────────────────────────────────────

  const getInterventionGroups = useCallback((): InterventionGroup[] => {
    const groups: Record<MasteryTier, InterventionGroup> = {
      red: {
        tier: 'red',
        name_en: INTERVENTION_GROUP_LABELS.red.en,
        name_bm: INTERVENTION_GROUP_LABELS.red.bm,
        students: [],
      },
      yellow: {
        tier: 'yellow',
        name_en: INTERVENTION_GROUP_LABELS.yellow.en,
        name_bm: INTERVENTION_GROUP_LABELS.yellow.bm,
        students: [],
      },
      green: {
        tier: 'green',
        name_en: INTERVENTION_GROUP_LABELS.green.en,
        name_bm: INTERVENTION_GROUP_LABELS.green.bm,
        students: [],
      },
      blue: {
        tier: 'blue',
        name_en: INTERVENTION_GROUP_LABELS.blue.en,
        name_bm: INTERVENTION_GROUP_LABELS.blue.bm,
        students: [],
      },
    };

    // For now, group by the worst tier across all topics
    progressByStudent.forEach((progressList, studentUid) => {
      const tiers = progressList.map((p) => p.tier);
      const worstTier: MasteryTier =
        tiers.includes('red')
          ? 'red'
          : tiers.includes('yellow')
            ? 'yellow'
            : tiers.includes('green')
              ? 'green'
              : 'blue';

      // For group C (green), split on masteryScore
      if (worstTier === 'green') {
        const topicScores = progressList.map((p) => {
          return (p.tier === 'blue' ? 95 : p.tier === 'green' ? 75 : 40) as number;
        });
        const avgScore: number = topicScores.length > 0 ? topicScores.reduce((a, b) => a + b) / topicScores.length : 75;

        if (avgScore < 90) {
          groups.green.students.push({
            uid: studentUid,
            name: studentNames[studentUid] ?? studentUid,
            masteryScore: Math.round(avgScore),
          });
        } else {
          groups.blue.students.push({
            uid: studentUid,
            name: studentNames[studentUid] ?? studentUid,
            masteryScore: Math.round(avgScore),
          });
        }
      } else {
        groups[worstTier].students.push({
          uid: studentUid,
          name: studentNames[studentUid] ?? studentUid,
          masteryScore: 50, // placeholder
        });
      }
    });

    return [groups.red, groups.yellow, groups.green, groups.blue];
  }, [progressByStudent, studentNames]);

  // ──────────────────────────────────────────────────────────────────────────
  // Handler: Toggle kiosk mode
  // ──────────────────────────────────────────────────────────────────────────

  const handleToggleKioskMode = async () => {
    if (!classData) return;

    try {
      const { error } = await supabase
        .from('classes')
        .update({ kiosk_mode: !classData.kioskMode })
        .eq('id', CLASS_ID);
      if (error) throw error;
    } catch (error) {
      console.error('[teacher] Error toggling kiosk mode:', error);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Handler: Generate class slip (calls /api/capsule/generate)
  // ──────────────────────────────────────────────────────────────────────────

  const handleGenerateClassSlip = async (tier: MasteryTier) => {
    if (!classData) return;

    const group = getInterventionGroups().find((g) => g.tier === tier);
    const rows = (group?.students ?? []).flatMap(
      (student) => progressByStudent.get(student.uid) ?? [],
    );
    const misconceptionId = pickTargetMisconception(rows);
    if (!misconceptionId) {
      showToast(
        language === 'en'
          ? 'No active misconception to build a slip from'
          : 'Tiada miskonsepsi aktif untuk slip ini',
      );
      return;
    }

    try {
      const details = await fetchMisconceptionDetails(misconceptionId);
      if (!details) throw new Error(`Misconception ${misconceptionId} not found`);

      const response = await fetch('/api/capsule/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'class_slip',
          misconceptionId: details.id,
          misconceptionName: details.name,
          wrongAnswerPattern: details.wrongAnswerPattern,
          remediationApproach: details.remediationApproach,
          subject: classData.subject,
          topic: details.topic || classData.topics[0],
          questionCount: 3,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const capsule: CapsuleResponse = await response.json();
      downloadCapsuleHtml(capsule, `class_slip_${tier}_${details.id}.html`);
      showToast(language === 'en' ? '✓ Class slip downloaded' : '✓ Slip kelas dimuat turun');
    } catch (error) {
      console.error('[teacher] Error generating class slip:', error);
      showToast(language === 'en' ? 'Failed to generate class slip' : 'Gagal menjana slip kelas');
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Handler: Select a student cell in the heatmap
  // ──────────────────────────────────────────────────────────────────────────

  const handleSelectStudent = async (studentUid: string) => {
    const progressList = progressByStudent.get(studentUid);
    if (!progressList || progressList.length === 0) return;

    // Fetch full student data from the profiles table
    try {
      const { data: profileRow, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', studentUid)
        .maybeSingle();
      if (error) throw error;

      setSelectedStudent({
        uid: studentUid,
        name: (profileRow?.name as string | undefined) || studentNames[studentUid] || 'Unknown',
        email: (profileRow?.email as string | undefined) || '',
        progressByTopic: progressList,
      });
      setPanelOpen(true);
    } catch (error) {
      console.error('[teacher] Error loading student:', error);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Handler: Generate individual capsule (calls /api/capsule/generate)
  // ──────────────────────────────────────────────────────────────────────────

  const handleGenerateIndividualCapsule = async () => {
    if (!selectedStudent || !classData) return;

    const misconceptionId = pickTargetMisconception(selectedStudent.progressByTopic);
    if (!misconceptionId) {
      showToast(
        language === 'en'
          ? 'This student has no active misconception'
          : 'Pelajar ini tiada miskonsepsi aktif',
      );
      return;
    }

    try {
      const details = await fetchMisconceptionDetails(misconceptionId);
      if (!details) throw new Error(`Misconception ${misconceptionId} not found`);

      const response = await fetch('/api/capsule/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'individual',
          misconceptionId: details.id,
          misconceptionName: details.name,
          wrongAnswerPattern: details.wrongAnswerPattern,
          remediationApproach: details.remediationApproach,
          subject: classData.subject,
          topic: details.topic || classData.topics[0],
          questionCount: 5,
          studentName: selectedStudent.name,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const capsule: CapsuleResponse = await response.json();
      downloadCapsuleHtml(capsule, `capsule_${selectedStudent.uid}.html`, selectedStudent.name);
      showToast(language === 'en' ? '✓ Capsule downloaded' : '✓ Kapsul dimuat turun');
    } catch (error) {
      console.error('[teacher] Error generating capsule:', error);
      showToast(language === 'en' ? 'Failed to generate capsule' : 'Gagal menjana kapsul');
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Render: Auth & loading states
  // ──────────────────────────────────────────────────────────────────────────

  if (authLoading || loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-blue-500 mx-auto" />
          <p className="text-slate-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (!uid) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center">
          <p className="text-slate-600">Please sign in to view the teacher dashboard.</p>
        </div>
      </div>
    );
  }

  if (!classData) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center">
          <p className="text-slate-600">Class not found</p>
        </div>
      </div>
    );
  }

  const interventionGroups = getInterventionGroups();

  // ──────────────────────────────────────────────────────────────────────────
  // Render: Main dashboard
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            {/* Class name */}
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{classData.name}</h1>
              <p className="text-sm text-slate-500">{classData.subject}</p>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {/* Push Pulse Check button */}
              <button
                type="button"
                onClick={handlePushPulse}
                disabled={pulseLoading}
                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                <span>📡</span>
                <span>
                  {pulseLoading
                    ? (language === 'en' ? 'Sending…' : 'Menghantar…')
                    : (language === 'en' ? 'Push Pulse Check' : 'Hantar Semakan Nadi')}
                </span>
              </button>

              {/* Paper Scanner button */}
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
              >
                <span>📷</span>
                <span>{language === 'en' ? 'Scan Paper' : 'Imbas Kertas'}</span>
              </button>

              {/* Kiosk mode toggle */}
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={classData.kioskMode}
                  onChange={handleToggleKioskMode}
                  className="h-4 w-4 rounded border-slate-300"
                />
                {language === 'en' ? 'Kiosk' : 'Kiosk'}
              </label>

              {/* Language toggle */}
              <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
                <button
                  onClick={() => setLanguage('en')}
                  className={cn(
                    'px-3 py-1 text-sm font-medium rounded',
                    language === 'en'
                      ? 'bg-blue-500 text-white'
                      : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  EN
                </button>
                <button
                  onClick={() => setLanguage('bm')}
                  className={cn(
                    'px-3 py-1 text-sm font-medium rounded',
                    language === 'bm'
                      ? 'bg-blue-500 text-white'
                      : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  BM
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main content + side panel */}
      <div className="flex gap-6 overflow-hidden">
        {/* Main content area */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
            {/* Pulse Toast */}
            <AnimatePresence>
              {pulseToast && (
                <motion.div
                  initial={{ opacity: 0, y: -20, x: '-50%' }}
                  animate={{ opacity: 1, y: 0, x: '-50%' }}
                  exit={{ opacity: 0, y: -20, x: '-50%' }}
                  className="fixed top-5 left-1/2 z-50 px-5 py-2.5 rounded-xl bg-green-600 text-white font-medium text-sm shadow-xl"
                >
                  {pulseToast}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Live Pulse Results Overlay */}
            {activePulse && (
              <section>
                <PulseResultsOverlay
                  pulse={activePulse}
                  responses={pulseResponses}
                  language={language}
                  onClose={() => setActivePulse(null)}
                />
              </section>
            )}

            {/* 1. ActionCard */}
            <section>
              <ActionCard
                classId={CLASS_ID}
                classSize={classData.studentCount || 30}
                subject={classData.subject}
                topic={classData.topics?.[0] || 'fractions'}
              />
            </section>

            {/* 2. Class Gap Map */}
            <section>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">
                  {language === 'en' ? 'Class Gap Map — Evidence' : 'Peta Jurang Kelas — Bukti'}
                </h2>
              </div>

              <div className="rounded-2xl bg-white p-6 shadow-sm border border-slate-100">
                <ClassGapMap
                  classId={CLASS_ID}
                  topics={classData.topics || ['fractions', 'decimals', 'percentages']}
                  language={language}
                  studentNames={studentNames}
                />
              </div>
            </section>

            {/* 3. Intervention Groups */}
            <section>
              <motion.div
                className="rounded-lg bg-white shadow-sm"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <button
                  onClick={() => setInterventionGroupsOpen(!interventionGroupsOpen)}
                  className="flex w-full items-center justify-between border-b border-slate-200 p-6 hover:bg-slate-50"
                >
                  <h2 className="text-lg font-semibold text-slate-900">
                    {language === 'en' ? 'Intervention Groups' : 'Kumpulan Campur Tangan'}
                  </h2>
                  <Menu className={cn('h-5 w-5 text-slate-600 transition-transform', interventionGroupsOpen && 'rotate-180')} />
                </button>

                <AnimatePresence>
                  {interventionGroupsOpen && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-6 p-6"
                    >
                      {interventionGroups.map((group) => (
                        <div key={group.tier}>
                          <div className="mb-3 flex items-center justify-between">
                            <h3 className="font-medium text-slate-900">
                              {language === 'en' ? group.name_en : group.name_bm}
                            </h3>
                            <span className={cn('rounded-full px-3 py-1 text-sm font-semibold', TIER_COLORS[group.tier].bg, TIER_COLORS[group.tier].text)}>
                              {group.students.length}
                            </span>
                          </div>

                          <div className="mb-4 flex flex-wrap gap-2">
                            {group.students.map((student) => (
                              <button
                                key={student.uid}
                                onClick={() => handleSelectStudent(student.uid)}
                                className="rounded-lg bg-slate-100 px-3 py-1 text-sm text-slate-700 hover:bg-slate-200 transition-colors"
                              >
                                {student.name}
                              </button>
                            ))}
                          </div>

                          {(group.tier === 'red' || group.tier === 'yellow') && (
                            <button
                              onClick={() => handleGenerateClassSlip(group.tier)}
                              className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors"
                            >
                              {language === 'en' ? 'Generate Class Slip' : 'Jana Slip Kelas'} →
                            </button>
                          )}
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </section>
          </div>
        </main>

        {/* Side panel */}
        <AnimatePresence>
          {panelOpen && selectedStudent && (
            <motion.div
              initial={{ x: 400, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 400, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="relative z-40 w-80 border-l border-slate-200 bg-white shadow-lg"
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-200 p-4">
                <h3 className="font-semibold text-slate-900">{selectedStudent.name}</h3>
                <button
                  onClick={() => {
                    setPanelOpen(false);
                    setSelectedStudent(null);
                  }}
                  className="text-slate-500 hover:text-slate-700"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Content */}
              <div className="space-y-6 overflow-y-auto p-4" style={{ height: 'calc(100vh - 8rem)' }}>
                {/* Tier badge */}
                <div>
                  <label className="text-xs font-semibold uppercase text-slate-500">
                    {language === 'en' ? 'Status' : 'Status'}
                  </label>
                  <div className="mt-2">
                    {selectedStudent.progressByTopic.map((progress) => (
                      <div key={progress.topic} className="mb-2 flex items-center gap-2">
                        <div className={cn('h-3 w-3 rounded-full', TIER_COLORS[progress.tier].dot)} />
                        <span className="text-sm font-medium capitalize text-slate-700">
                          {progress.topic}: {language === 'en' ? TIER_LABELS[progress.tier].en : TIER_LABELS[progress.tier].bm}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Active misconceptions */}
                <div>
                  <label className="text-xs font-semibold uppercase text-slate-500">
                    {language === 'en' ? 'Active Misconceptions' : 'Konsepsi Salah Aktif'}
                  </label>
                  <div className="mt-2 space-y-2">
                    {selectedStudent.progressByTopic
                      .flatMap((progress) =>
                        progress.activeMisconceptions
                          .filter((m) => !m.isCleared)
                          .map((m) => ({ ...m, topic: progress.topic })),
                      )
                      .map((m) => (
                        <div key={`${m.topic}-${m.misconceptionId}`} className="rounded-lg bg-slate-100 p-3 text-sm">
                          <p className="font-medium text-slate-900 capitalize">
                            {m.misconceptionId.replace(/_/g, ' ')}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5 capitalize">{m.topic}</p>
                        </div>
                      ))}
                  </div>
                </div>

                {/* Assign individual capsule button */}
                <div>
                  <button
                    onClick={handleGenerateIndividualCapsule}
                    className="w-full rounded-lg bg-green-500 px-4 py-2 font-medium text-white hover:bg-green-600 transition-colors"
                  >
                    {language === 'en' ? 'Assign Individual Capsule' : 'Serahkan Kapsul Peribadi'}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Backdrop */}
        <AnimatePresence>
          {panelOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setPanelOpen(false);
                setSelectedStudent(null);
              }}
              className="fixed inset-0 z-30 bg-black/20"
            />
          )}
        </AnimatePresence>
      </div>

      {/* Paper Scanner Drawer */}
      <PaperScanner
        classId={CLASS_ID}
        questionLabels={['Q1', 'Q2', 'Q3']}
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onResultsProcessed={() => {}}
      />
    </div>
  );
}
