'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { RealtimeChannel } from '@supabase/supabase-js';
import QuizQuestion, { type QuizQuestionData } from '@/components/QuizQuestion';
import FeedbackCard from '@/components/FeedbackCard';
import { supabase } from '@/lib/supabase-client';
import {
  getNextQuestionParams,
  type StudentProgress,
  type StudentTier,
  type ConfidenceLevel,
  type Answer,
} from '@/lib/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Demo student — in production this comes from auth
const STUDENT_ID = 'demo_student_001';
const CLASS_ID = 'class_6A';
const SUBJECT = 'mathematics';
const CURRENT_TOPIC = 'fractions';
const TOTAL_MISSIONS = 4;
const MISSION_INDEX = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Pulse types
// ─────────────────────────────────────────────────────────────────────────────

interface PulseQuestion {
  questionId: string;
  questionText: string;
  options: { A: string; B: string; C: string; D: string };
  correctOption: string;
}

interface PulseRow {
  id: string;
  class_id: string;
  questions: PulseQuestion[];
  status: 'active' | 'completed' | 'expired';
  created_at: string;
}

const MISSIONS: Record<number, { label_en: string; label_bm: string }> = {
  0: {
    label_en: 'Mission 1: Build equivalent fractions',
    label_bm: 'Misi 1: Bina pecahan setara',
  },
  1: {
    label_en: 'Mission 2: Add fractions with different denominators',
    label_bm: 'Misi 2: Tambah pecahan berlainan penyebut',
  },
  2: {
    label_en: 'Mission 3: Solve a real-world measurement problem',
    label_bm: 'Misi 3: Selesaikan masalah pengukuran dunia nyata',
  },
  3: {
    label_en: 'Mission 4: Challenge — advanced applications',
    label_bm: 'Misi 4: Cabaran — aplikasi lanjutan',
  },
};

type Language = 'en' | 'bm';
type PhaseType = 'question' | 'feedback';

interface AnswerState {
  selectedOption: string;
  isCorrect: boolean;
  misconceptionId: string | null;
  misconceptionLabel: string | null;
  misconceptionLabel_bm: string | null;
  confidenceLevel: ConfidenceLevel;
  timeSpentMs: number;
  answerChanges: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

function defaultProgress(studentUid: string, classId: string, topic: string): StudentProgress {
  return {
    studentUid,
    classId,
    topic,
    tier: 'green',
    activeMisconceptions: [],
    masteryScore: 0,
    consecutiveCorrect: 0,
    transferPassed: false,
    sessionsActive: 1,
  };
}

async function fetchMisconceptionLabels(
  misconceptionId: string,
): Promise<{ en: string | null; bm: string | null }> {
  const { data } = await supabase
    .from('misconceptions')
    .select('plain_language_label, plain_language_label_bm')
    .eq('id', misconceptionId)
    .maybeSingle();

  return {
    en: (data?.plain_language_label as string | undefined) ?? null,
    bm: (data?.plain_language_label_bm as string | undefined) ?? null,
  };
}

const TIER_STYLES: Record<
  StudentTier,
  { dot: string; badge: string; label_en: string; label_bm: string }
> = {
  red: {
    dot: 'bg-red-500',
    badge: 'bg-red-100 border-red-200 text-red-700',
    label_en: 'Needs support',
    label_bm: 'Perlu sokongan',
  },
  yellow: {
    dot: 'bg-yellow-400',
    badge: 'bg-yellow-50 border-yellow-200 text-yellow-700',
    label_en: 'Developing',
    label_bm: 'Sedang berkembang',
  },
  green: {
    dot: 'bg-green-500',
    badge: 'bg-green-50 border-green-200 text-green-700',
    label_en: 'Mastered',
    label_bm: 'Dikuasai',
  },
  blue: {
    dot: 'bg-blue-500',
    badge: 'bg-blue-50 border-blue-200 text-blue-700',
    label_en: 'Advanced',
    label_bm: 'Lanjutan',
  },
};

const TOPIC_DISPLAY: Record<string, { en: string; bm: string }> = {
  fractions: { en: 'Fractions', bm: 'Pecahan' },
  decimals: { en: 'Decimals', bm: 'Perpuluhan' },
  percentages: { en: 'Percentages', bm: 'Peratusan' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Mission progress bar
// ─────────────────────────────────────────────────────────────────────────────

function MissionProgressBar({
  current,
  total,
  language,
}: {
  current: number;
  total: number;
  language: Language;
}) {
  const pct = Math.min(100, Math.round((current / total) * 100));
  const label =
    language === 'bm'
      ? `Misi ${current} daripada ${total}`
      : `Mission ${current} of ${total}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs font-medium text-slate-500">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Topic mastery card
// ─────────────────────────────────────────────────────────────────────────────

function TopicMasteryCard({
  progress,
  activeMisconceptionLabel,
  language,
}: {
  progress: StudentProgress;
  activeMisconceptionLabel: string | null;
  language: Language;
}) {
  const tier = progress.tier;
  const styles = TIER_STYLES[tier];
  const topicName = TOPIC_DISPLAY[progress.topic]?.[language] ?? progress.topic;
  const hasUnclearedMisconception = progress.activeMisconceptions.some((m) => !m.isCleared);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'rounded-xl border-2 p-4 transition-shadow duration-200',
        styles.badge,
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-semibold text-sm leading-tight">{topicName}</span>
        <span
          className={cn('flex-shrink-0 w-3 h-3 rounded-full', styles.dot)}
          title={tier.toUpperCase()}
          aria-label={`${tier} tier`}
        />
      </div>

      {/* Tier label */}
      <p className="text-xs font-medium uppercase tracking-wide opacity-70 mb-1.5">
        {tier === 'red' || tier === 'yellow'
          ? tier.toUpperCase()
          : tier === 'green'
          ? language === 'bm'
            ? '✓ Dikuasai'
            : '✓ Mastered'
          : language === 'bm'
          ? '⭐ Lanjutan'
          : '⭐ Advanced'}
      </p>

      {/* Misconception hint */}
      {(tier === 'red' || tier === 'yellow') && hasUnclearedMisconception && activeMisconceptionLabel && (
        <p className="text-[11px] leading-snug opacity-80 italic line-clamp-2">
          &quot;{activeMisconceptionLabel}&quot;
        </p>
      )}

      {/* Mastery score */}
      <p className="text-[10px] mt-2 opacity-50">
        {language === 'bm'
          ? `Skor penguasaan: ${progress.masteryScore}`
          : `Mastery score: ${progress.masteryScore}`}
      </p>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Mastery Map panel
// ─────────────────────────────────────────────────────────────────────────────

function MasteryMapPanel({
  progress,
  activeMisconceptionLabel,
  language,
  onLanguageToggle,
}: {
  progress: StudentProgress;
  activeMisconceptionLabel: string | null;
  language: Language;
  onLanguageToggle: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold text-slate-800">
            {language === 'bm' ? 'Peta Penguasaan' : 'Mastery Map'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {language === 'bm'
              ? 'Kemas kini masa nyata'
              : 'Updates in real time'}
          </p>
        </div>

        {/* Language toggle */}
        <button
          type="button"
          id="language-toggle"
          onClick={onLanguageToggle}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-full border-2 text-xs font-bold',
            'transition-all duration-200',
            language === 'bm'
              ? 'border-blue-500 bg-blue-50 text-blue-700'
              : 'border-slate-300 bg-white text-slate-600 hover:border-blue-300',
          )}
          aria-label="Toggle language"
        >
          <span
            className={cn(
              'transition-opacity',
              language === 'en' ? 'opacity-100' : 'opacity-40',
            )}
          >
            EN
          </span>
          <span className="opacity-30">/</span>
          <span
            className={cn(
              'transition-opacity',
              language === 'bm' ? 'opacity-100' : 'opacity-40',
            )}
          >
            BM
          </span>
        </button>
      </div>

      {/* Tier legend */}
      <div className="flex flex-wrap gap-2 mb-4">
        {(
          [
            ['red', '#ef4444'],
            ['yellow', '#facc15'],
            ['green', '#22c55e'],
            ['blue', '#3b82f6'],
          ] as const
        ).map(([tier, color]) => (
          <div key={tier} className="flex items-center gap-1 text-[10px] text-slate-500">
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: color }}
            />
            {tier.toUpperCase()}
          </div>
        ))}
      </div>

      {/* Topic cards */}
      <div className="grid grid-cols-1 gap-3 overflow-y-auto flex-1 pr-1">
        <AnimatePresence mode="popLayout">
          <TopicMasteryCard
            key={progress.topic}
            progress={progress}
            activeMisconceptionLabel={activeMisconceptionLabel}
            language={language}
          />
        </AnimatePresence>
      </div>

      {/* Realtime indicator */}
      <div className="flex items-center gap-1.5 mt-4 pt-3 border-t border-slate-100">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        <span className="text-[10px] text-slate-400">
          {language === 'bm' ? 'Tersambung ke Supabase' : 'Live — Supabase connected'}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Error banner
// ─────────────────────────────────────────────────────────────────────────────

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border-2 border-red-200 bg-red-50 px-5 py-4 flex items-center justify-between gap-4">
      <p className="text-sm text-red-700 font-medium">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="flex-shrink-0 text-sm font-semibold text-red-700 underline underline-offset-2"
      >
        Retry
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Pulse toast banner
// ─────────────────────────────────────────────────────────────────────────────

function PulseToast({
  visible,
  language,
}: {
  visible: boolean;
  language: Language;
}) {
  const msg =
    language === 'bm'
      ? 'Guru anda telah menghantar semakan pantas!'
      : 'Your teacher has sent a quick check!';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -20, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: -20, x: '-50%' }}
          transition={{ duration: 0.3 }}
          className="fixed top-4 left-1/2 z-50 px-5 py-3 rounded-xl shadow-lg bg-blue-600 text-white text-sm font-semibold"
        >
          📡 {msg}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: PulseQuiz overlay
// ─────────────────────────────────────────────────────────────────────────────

function PulseQuizOverlay({
  pulse,
  studentId,
  language,
  onComplete,
}: {
  pulse: PulseRow;
  studentId: string;
  language: Language;
  onComplete: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<
    { questionIndex: number; selectedOption: string }[]
  >([]);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const question = pulse.questions[currentIndex];
  const isLast = currentIndex === pulse.questions.length - 1;

  const headerText =
    language === 'bm' ? 'Semakan Nadi Guru' : 'Teacher Pulse Check';
  const progressText =
    language === 'bm'
      ? `Soalan ${currentIndex + 1} daripada ${pulse.questions.length}`
      : `Question ${currentIndex + 1} of ${pulse.questions.length}`;
  const nextText = language === 'bm' ? 'Seterusnya' : 'Next';
  const submitText = language === 'bm' ? 'Hantar' : 'Submit';

  const handleNext = useCallback(async () => {
    if (!selectedOption) return;

    const newAnswers = [
      ...answers,
      { questionIndex: currentIndex, selectedOption },
    ];
    setAnswers(newAnswers);

    if (isLast) {
      // Write pulse_response via the service-role route (this demo student
      // session has no real Supabase Auth session for RLS to match against).
      setSubmitting(true);
      try {
        const res = await fetch('/api/pulse/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pulseId: pulse.id,
            studentId,
            classId: pulse.class_id,
            answers: newAnswers,
          }),
        });

        if (!res.ok) {
          console.error('[student] pulse response write failed:', await res.text());
        }
      } catch (err) {
        console.error('[student] pulse response write failed:', err);
      }
      setSubmitting(false);
      onComplete();
    } else {
      setCurrentIndex((i) => i + 1);
      setSelectedOption(null);
    }
  }, [selectedOption, answers, currentIndex, isLast, pulse, studentId, onComplete]);

  if (!question) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Card */}
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 20 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="relative z-10 w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-500 to-indigo-600 px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            <h2 className="text-white font-bold text-sm">{headerText}</h2>
          </div>
          <p className="text-blue-100 text-xs">{progressText}</p>
        </div>

        {/* Question */}
        <div className="px-5 py-5 space-y-4">
          <p className="text-sm font-medium text-gray-800 leading-relaxed">
            {question.questionText}
          </p>

          {/* Options — no confidence buttons for pulse */}
          <div className="space-y-2">
            {(['A', 'B', 'C', 'D'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setSelectedOption(opt)}
                className={cn(
                  'w-full text-left px-4 py-3 rounded-xl border-2 text-sm',
                  'transition-all duration-150',
                  selectedOption === opt
                    ? 'border-blue-500 bg-blue-50 text-blue-800 font-semibold'
                    : 'border-gray-200 bg-white text-gray-700 hover:border-blue-200 hover:bg-blue-50/30',
                )}
              >
                <span className="font-bold mr-2 text-gray-400">{opt}.</span>
                {question.options[opt]}
              </button>
            ))}
          </div>

          {/* Next/Submit button */}
          <button
            type="button"
            onClick={handleNext}
            disabled={!selectedOption || submitting}
            className={cn(
              'w-full py-3 rounded-xl text-sm font-semibold',
              'transition-all duration-150',
              !selectedOption || submitting
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm',
            )}
          >
            {submitting
              ? '...'
              : isLast
              ? submitText
              : nextText}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function StudentPage() {
  // ── State ─────────────────────────────────────────────────────────────────
  const [language, setLanguage] = useState<Language>('en');
  const [phase, setPhase] = useState<PhaseType>('question');

  const [question, setQuestion] = useState<QuizQuestionData | null>(null);
  const [questionLoading, setQuestionLoading] = useState(true);
  const [questionError, setQuestionError] = useState<string | null>(null);

  const [answerState, setAnswerState] = useState<AnswerState | null>(null);

  const [studentProgress, setStudentProgress] = useState<StudentProgress>(
    defaultProgress(STUDENT_ID, CLASS_ID, CURRENT_TOPIC),
  );
  const [activeMisconceptionLabel, setActiveMisconceptionLabel] = useState<string | null>(null);

  // Pulse state
  const [activePulse, setActivePulse] = useState<PulseRow | null>(null);
  const [showPulseToast, setShowPulseToast] = useState(false);
  const [showPulseOverlay, setShowPulseOverlay] = useState(false);

  // Tracking refs across question chain
  const studentProgressRef = useRef<StudentProgress>(studentProgress);
  const sessionHistoryRef = useRef<Answer[]>([]);
  const recentQuestionsRef = useRef<string[]>([]);

  useEffect(() => {
    studentProgressRef.current = studentProgress;
  }, [studentProgress]);

  // ── Derived UI state ─────────────────────────────────────────────────────

  const missionLabel =
    language === 'bm'
      ? MISSIONS[MISSION_INDEX]?.label_bm
      : MISSIONS[MISSION_INDEX]?.label_en;

  const isBlue = studentProgress.tier === 'blue';

  // Keep the active misconception's display label in sync with whichever
  // misconception is currently uncleared for this topic.
  useEffect(() => {
    const active = studentProgress.activeMisconceptions.find((m) => !m.isCleared);
    if (!active) {
      setActiveMisconceptionLabel(null);
      return;
    }

    let cancelled = false;
    fetchMisconceptionLabels(active.misconceptionId).then((labels) => {
      if (cancelled) return;
      setActiveMisconceptionLabel(language === 'bm' ? labels.bm ?? labels.en : labels.en);
    });

    return () => {
      cancelled = true;
    };
  }, [studentProgress.activeMisconceptions, language]);

  // ── Fetch question ─────────────────────────────────────────────────────────

  const fetchQuestion = useCallback(async () => {
    setQuestionLoading(true);
    setQuestionError(null);

    try {
      const progress = studentProgressRef.current;
      const nextParams = getNextQuestionParams(progress, sessionHistoryRef.current);

      let activeMisconceptionDescription: string | null = null;
      if (nextParams.misconceptionId) {
        const labels = await fetchMisconceptionLabels(nextParams.misconceptionId);
        activeMisconceptionDescription =
          language === 'bm' ? labels.bm ?? labels.en : labels.en;
      }

      const body = {
        subject: SUBJECT,
        topic: CURRENT_TOPIC,
        difficulty: nextParams.difficulty,
        activeMisconceptionId: nextParams.misconceptionId,
        activeMisconceptionDescription,
        previousQuestionTexts: recentQuestionsRef.current.slice(-5),
        isTransferQuestion: nextParams.isTransferQuestion,
        isResetQuestion: nextParams.isResetQuestion,
      };

      const res = await fetch('/api/quiz/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data: QuizQuestionData = await res.json();
      setQuestion(data);

      // Track for de-duplication
      recentQuestionsRef.current = [
        ...recentQuestionsRef.current.slice(-9),
        data.questionText,
      ];
    } catch (err) {
      console.error('[student] fetchQuestion error', err);
      setQuestionError('Could not load the next question. Please retry.');
    } finally {
      setQuestionLoading(false);
    }
  }, [language]);

  // ── Classify misconception ────────────────────────────────────────────────

  const classifyMisconception = useCallback(
    async (
      q: QuizQuestionData,
      selectedOption: string,
    ): Promise<{ misconceptionId: string; label: string; label_bm: string }> => {
      try {
        const res = await fetch('/api/quiz/classify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questionText: q.questionText,
            correctAnswer: q.options[q.correctOption as keyof typeof q.options],
            studentAnswer: q.options[selectedOption as keyof typeof q.options],
            subject: SUBJECT,
            topic: CURRENT_TOPIC,
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const labels = await fetchMisconceptionLabels(data.misconceptionId as string);
        return {
          misconceptionId: data.misconceptionId,
          label: labels.en ?? data.reasoning,
          label_bm: labels.bm ?? data.reasoning,
        };
      } catch {
        // Fall back to existing active misconception
        const active = studentProgressRef.current.activeMisconceptions.find(
          (m) => !m.isCleared,
        );
        return {
          misconceptionId: active?.misconceptionId ?? 'unknown',
          label: 'Review this concept carefully.',
          label_bm: 'Semak konsep ini dengan teliti.',
        };
      }
    },
    [],
  );

  // ── onSubmit (from QuizQuestion) ──────────────────────────────────────────

  const handleQuestionSubmit = useCallback(
    async (
      selectedOption: string,
      confidenceLevel: ConfidenceLevel,
      timeSpentMs: number,
      answerChanges: number,
    ) => {
      if (!question) return;

      const isCorrect = selectedOption === question.correctOption;

      // Classify misconception if wrong
      let misconceptionId: string | null = null;
      let misconceptionLabel: string | null = null;
      let misconceptionLabel_bm: string | null = null;

      if (!isCorrect) {
        const classified = await classifyMisconception(question, selectedOption);
        misconceptionId = classified.misconceptionId;
        misconceptionLabel = classified.label;
        misconceptionLabel_bm = classified.label_bm;
      }

      setAnswerState({
        selectedOption,
        isCorrect,
        misconceptionId,
        misconceptionLabel,
        misconceptionLabel_bm,
        confidenceLevel,
        timeSpentMs,
        answerChanges,
      });

      const answer: Answer = {
        studentUid: STUDENT_ID,
        classId: CLASS_ID,
        topic: CURRENT_TOPIC,
        isCorrect,
        isTransferQuestion: question.isTransferQuestion,
        misconceptionId,
        confidenceLevel,
      };

      sessionHistoryRef.current = [...sessionHistoryRef.current, answer];

      // Progress read/write goes through the shared service-role route (this
      // demo student session has no real Supabase Auth session for RLS to
      // match against).
      try {
        const res = await fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            studentId: STUDENT_ID,
            classId: CLASS_ID,
            topic: CURRENT_TOPIC,
            isCorrect,
            isTransferQuestion: question.isTransferQuestion,
            misconceptionId,
            confidenceLevel,
          }),
        });

        if (res.ok) {
          const data: { progress: StudentProgress } = await res.json();
          setStudentProgress(data.progress);
        }
      } catch (err) {
        console.error('[student] updateStudentProgress error', err);
      }

      setPhase('feedback');
    },
    [question, classifyMisconception],
  );

  // ── onNext (from FeedbackCard) ────────────────────────────────────────────

  const handleNext = useCallback(() => {
    setPhase('question');
    setAnswerState(null);
    fetchQuestion();
  }, [fetchQuestion]);

  // ── Initial progress load ─────────────────────────────────────────────────
  // Goes through the shared service-role route rather than a direct table
  // read/realtime subscription — this demo student session has no real
  // Supabase Auth session for `student_progress`'s RLS policies to match
  // against. Progress otherwise stays in sync via the POST response after
  // each answer submission (see handleQuestionSubmit).

  useEffect(() => {
    let cancelled = false;

    async function loadInitialProgress() {
      try {
        const res = await fetch(
          `/api/progress?studentId=${encodeURIComponent(STUDENT_ID)}&classId=${encodeURIComponent(
            CLASS_ID,
          )}&topic=${encodeURIComponent(CURRENT_TOPIC)}`,
        );
        if (cancelled || !res.ok) return;

        const data: { progress: StudentProgress } = await res.json();
        setStudentProgress(data.progress);
      } catch (err) {
        console.error('[student] loadInitialProgress error', err);
      }
    }

    loadInitialProgress();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Initial question load ────────────────────────────────────────────────

  useEffect(() => {
    fetchQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pulse detection — Supabase realtime on `pulses` ──────────────────────

  useEffect(() => {
    let currentChannel: RealtimeChannel | null = null;

    const channel = supabase
      .channel(`pulses-${CLASS_ID}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pulses',
          filter: `class_id=eq.${CLASS_ID}`,
        },
        (payload) => {
          // Realtime filters only support a single `eq`, so the `status`
          // condition from the old Firestore query is applied client-side.
          const row = payload.new as PulseRow | undefined;

          if (payload.eventType === 'DELETE' || !row || row.status !== 'active') {
            setActivePulse((prev) => {
              const deletedRow = payload.old as Partial<PulseRow> | undefined;
              if (deletedRow && prev && deletedRow.id === prev.id) {
                setShowPulseOverlay(false);
                return null;
              }
              return prev;
            });
            return;
          }

          setActivePulse((prev) => {
            if (prev && prev.id === row.id) return prev;
            setShowPulseToast(true);
            setShowPulseOverlay(true);
            setTimeout(() => setShowPulseToast(false), 4000);
            return row;
          });
        },
      )
      .subscribe();

    currentChannel = channel;

    return () => {
      if (currentChannel) supabase.removeChannel(currentChannel);
    };
  }, []);

  const handlePulseComplete = useCallback(() => {
    setShowPulseOverlay(false);
    setActivePulse(null);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-violet-50/20">
      {/* ── Pulse toast ── */}
      <PulseToast visible={showPulseToast} language={language} />

      {/* ── Pulse quiz overlay ── */}
      <AnimatePresence>
        {showPulseOverlay && activePulse && (
          <PulseQuizOverlay
            pulse={activePulse}
            studentId={STUDENT_ID}
            language={language}
            onComplete={handlePulseComplete}
          />
        )}
      </AnimatePresence>

      {/* ── Page header ── */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-100 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-white font-bold text-sm select-none">
              M
            </div>
            <div>
              <span className="font-bold text-slate-800 text-sm">
                Mosaic Classroom
              </span>
              <span className="hidden sm:inline text-slate-400 text-xs ml-2">
                Student View
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="hidden sm:inline">
              {language === 'bm'
                ? `Pelajar: ${STUDENT_ID}`
                : `Student: ${STUDENT_ID}`}
            </span>
          </div>
        </div>
      </header>

      {/* ── Main layout ── */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 lg:py-8">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">

          {/* ══════════════════════════════════════════════════
              SECTION 1 — Active Mission (60%)
          ══════════════════════════════════════════════════ */}
          <section className="flex-1 lg:w-[60%] min-w-0 space-y-5">

            {/* Mission header card */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 space-y-3">
              {/* Mission label */}
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    'px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide',
                    isBlue
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-violet-100 text-violet-700',
                  )}
                >
                  {isBlue
                    ? language === 'bm'
                      ? 'Tier Biru'
                      : 'Blue Tier'
                    : language === 'bm'
                    ? 'Aktif'
                    : 'Active'}
                </span>
                <h1 className="text-sm font-semibold text-slate-700">
                  {missionLabel}
                </h1>
              </div>

              {/* Progress bar */}
              <MissionProgressBar
                current={Math.min(MISSION_INDEX + 1, TOTAL_MISSIONS)}
                total={TOTAL_MISSIONS}
                language={language}
              />
            </div>

            {/* Error state */}
            {questionError && (
              <ErrorBanner
                message={questionError}
                onRetry={() => fetchQuestion()}
              />
            )}

            {/* Question / Feedback area */}
            <AnimatePresence mode="wait">
              {phase === 'question' ? (
                <motion.div
                  key="question"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  {question || questionLoading ? (
                    <QuizQuestion
                      question={
                        question ?? {
                          questionId: 'loading',
                          questionText: '',
                          options: { A: '', B: '', C: '', D: '' },
                          correctOption: 'A',
                          isTransferQuestion: false,
                          isResetQuestion: false,
                        }
                      }
                      onSubmit={handleQuestionSubmit}
                      language={language}
                      isLoading={questionLoading}
                    />
                  ) : null}
                </motion.div>
              ) : (
                <motion.div
                  key="feedback"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  {answerState && question && (
                    <FeedbackCard
                      isCorrect={answerState.isCorrect}
                      misconceptionId={answerState.misconceptionId}
                      misconceptionLabel={answerState.misconceptionLabel}
                      misconceptionLabel_bm={answerState.misconceptionLabel_bm}
                      isTransferQuestion={question.isTransferQuestion}
                      isResetQuestion={question.isResetQuestion}
                      confidenceLevel={answerState.confidenceLevel}
                      language={language}
                      onNext={handleNext}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* ══════════════════════════════════════════════════
              SECTION 2 — Mastery Map (40%)
          ══════════════════════════════════════════════════ */}
          <aside className="lg:w-[40%] lg:max-w-sm flex-shrink-0">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-5 lg:sticky lg:top-24">
              <MasteryMapPanel
                progress={studentProgress}
                activeMisconceptionLabel={activeMisconceptionLabel}
                language={language}
                onLanguageToggle={() =>
                  setLanguage((l) => (l === 'en' ? 'bm' : 'en'))
                }
              />
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
