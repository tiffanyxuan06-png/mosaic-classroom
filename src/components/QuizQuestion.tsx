'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface QuizQuestionData {
  questionId: string;
  questionText: string;
  options: { A: string; B: string; C: string; D: string };
  correctOption: string;
  isTransferQuestion: boolean;
  isResetQuestion: boolean;
}

type ConfidenceLevel = 'guessed' | 'unsure' | 'knew';
type OptionKey = 'A' | 'B' | 'C' | 'D';

export interface QuizQuestionProps {
  question: QuizQuestionData;
  onSubmit: (
    selectedOption: string,
    confidenceLevel: ConfidenceLevel,
    timeSpentMs: number,
    answerChanges: number,
  ) => void;
  language: 'en' | 'bm';
  isLoading: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Utility: cn helper (lightweight clsx substitute — no extra deps)
// ────────────────────────────────────────────────────────────────────────────

function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-component: Skeleton loader
// ────────────────────────────────────────────────────────────────────────────

function SkeletonLoader() {
  return (
    <div
      role="status"
      aria-label="Loading question"
      className="animate-pulse space-y-5"
    >
      {/* Question text skeleton */}
      <div className="space-y-2">
        <div className="h-5 bg-slate-200 rounded-lg w-full" />
        <div className="h-5 bg-slate-200 rounded-lg w-4/5" />
        <div className="h-5 bg-slate-200 rounded-lg w-3/5" />
      </div>

      {/* Options skeleton */}
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className="h-14 bg-slate-200 rounded-xl w-full"
        />
      ))}

      <span className="sr-only">Loading next question…</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-component: TTS button
// ────────────────────────────────────────────────────────────────────────────

interface TtsButtonProps {
  text: string;
  lang: string;
  disabled: boolean;
}

function TtsButton({ text, lang, disabled }: TtsButtonProps) {
  const [speaking, setSpeaking] = useState(false);

  function handleSpeak() {
    if (!('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;

    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);

    window.speechSynthesis.speak(utterance);
  }

  return (
    <button
      type="button"
      id="tts-button"
      onClick={handleSpeak}
      disabled={disabled}
      aria-label={speaking ? 'Reading question aloud…' : 'Read question aloud'}
      title={speaking ? 'Reading…' : 'Read aloud'}
      className={cn(
        'flex-shrink-0 flex items-center justify-center',
        'w-9 h-9 rounded-full border transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
        speaking
          ? 'border-blue-400 bg-blue-50 text-blue-600 shadow-inner animate-pulse'
          : 'border-slate-300 bg-white text-slate-500 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      {/* Speaker SVG — drawn inline so no icon-library needed */}
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className="w-4 h-4"
        aria-hidden="true"
      >
        {speaking ? (
          /* Animated waves when speaking */
          <path d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" />
        ) : (
          /* Single speaker icon at rest */
          <path d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 1.414L13 9.414V10.586l.707.707a1 1 0 01-1.414 1.414l-1-1A1 1 0 0111 11V9a1 1 0 01.293-.707l1-1z" />
        )}
      </svg>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-component: Option button
// ────────────────────────────────────────────────────────────────────────────

interface OptionButtonProps {
  letter: OptionKey;
  text: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}

function OptionButton({
  letter,
  text,
  selected,
  disabled,
  onClick,
}: OptionButtonProps) {
  return (
    <button
      type="button"
      id={`option-${letter}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-4 rounded-xl border-2 text-left',
        'transition-all duration-150 active:scale-[0.98]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
        selected
          ? 'border-blue-500 bg-blue-50 shadow-sm shadow-blue-200'
          : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50/40',
        disabled && !selected && 'opacity-60 cursor-not-allowed',
        disabled && 'cursor-not-allowed',
      )}
    >
      {/* Letter badge */}
      <span
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
          'text-sm font-bold transition-colors duration-150',
          selected
            ? 'bg-blue-500 text-white'
            : 'bg-slate-100 text-slate-600',
        )}
        aria-hidden="true"
      >
        {letter}
      </span>

      {/* Option text */}
      <span
        className={cn(
          'text-base leading-snug transition-colors duration-150',
          selected ? 'text-blue-900 font-medium' : 'text-slate-700',
        )}
      >
        {text}
      </span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-component: Confidence button
// ────────────────────────────────────────────────────────────────────────────

interface ConfidenceButtonProps {
  level: ConfidenceLevel;
  label: string;
  emoji: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}

const CONFIDENCE_STYLES: Record<ConfidenceLevel, { base: string; active: string }> = {
  guessed: {
    base: 'border-orange-200 text-orange-700 hover:border-orange-400 hover:bg-orange-50',
    active: 'border-orange-400 bg-orange-50 shadow-sm shadow-orange-200',
  },
  unsure: {
    base: 'border-yellow-200 text-yellow-700 hover:border-yellow-400 hover:bg-yellow-50',
    active: 'border-yellow-400 bg-yellow-50 shadow-sm shadow-yellow-200',
  },
  knew: {
    base: 'border-green-200 text-green-700 hover:border-green-400 hover:bg-green-50',
    active: 'border-green-400 bg-green-50 shadow-sm shadow-green-200',
  },
};

function ConfidenceButton({
  level,
  label,
  emoji,
  selected,
  disabled,
  onClick,
}: ConfidenceButtonProps) {
  const styles = CONFIDENCE_STYLES[level];

  return (
    <button
      type="button"
      id={`confidence-${level}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'flex-1 flex flex-col items-center gap-1 px-3 py-3 rounded-xl border-2',
        'text-sm font-medium transition-all duration-150 active:scale-[0.97]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        level === 'guessed' && 'focus-visible:ring-orange-400',
        level === 'unsure' && 'focus-visible:ring-yellow-400',
        level === 'knew' && 'focus-visible:ring-green-400',
        selected ? styles.active : styles.base,
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      <span className="text-xl leading-none" aria-hidden="true">{emoji}</span>
      <span>{label}</span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

const OPTION_KEYS: OptionKey[] = ['A', 'B', 'C', 'D'];

const LABELS = {
  en: {
    badge_transfer: 'Application question',
    badge_reset: 'Quick check',
    howConfident: 'How confident were you?',
    guessed: 'I guessed',
    unsure: 'I was unsure',
    knew: 'I knew this',
    submit: 'Submit answer',
    submitting: 'Submitting…',
  },
  bm: {
    badge_transfer: 'Soalan aplikasi',
    badge_reset: 'Semak pantas',
    howConfident: 'Sejauh mana keyakinan anda?',
    guessed: 'Saya meneka',
    unsure: 'Saya tidak pasti',
    knew: 'Saya tahu ini',
    submit: 'Hantar jawapan',
    submitting: 'Menghantar…',
  },
} as const;

export default function QuizQuestion({
  question,
  onSubmit,
  language,
  isLoading,
}: QuizQuestionProps) {
  const t = LABELS[language];
  const ttsLang = language === 'bm' ? 'ms-MY' : 'en-US';

  // ── State ─────────────────────────────────────────────────────────────────
  const [selectedOption, setSelectedOption] = useState<OptionKey | null>(null);
  const [confidence, setConfidence] = useState<ConfidenceLevel | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Tracking refs (don't need to cause re-renders) ─────────────────────
  const startTimeRef = useRef<number>(Date.now());
  const answerChangesRef = useRef<number>(0);
  const prevOptionRef = useRef<OptionKey | null>(null);

  // Reset all state when the question changes
  useEffect(() => {
    setSelectedOption(null);
    setConfidence(null);
    setSubmitting(false);
    startTimeRef.current = Date.now();
    answerChangesRef.current = 0;
    prevOptionRef.current = null;

    // Stop any in-progress TTS
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, [question.questionId]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleOptionClick = useCallback(
    (key: OptionKey) => {
      if (isLoading || submitting) return;

      setSelectedOption((prev) => {
        // Deselect on re-tap
        if (prev === key) return null;

        // Count only meaningful changes (prev → new, not initial selection)
        if (prevOptionRef.current !== null) {
          answerChangesRef.current += 1;
        }
        prevOptionRef.current = key;
        return key;
      });

      // Reset confidence when answer changes
      setConfidence(null);
    },
    [isLoading, submitting],
  );

  const handleConfidenceClick = useCallback(
    (level: ConfidenceLevel) => {
      if (isLoading || submitting || !selectedOption) return;
      setConfidence((prev) => (prev === level ? null : level));
    },
    [isLoading, submitting, selectedOption],
  );

  const handleSubmit = useCallback(() => {
    if (!selectedOption || !confidence || submitting) return;

    setSubmitting(true);
    const timeSpentMs = Date.now() - startTimeRef.current;
    onSubmit(selectedOption, confidence, timeSpentMs, answerChangesRef.current);
  }, [selectedOption, confidence, submitting, onSubmit]);

  const canSubmit = !!selectedOption && !!confidence && !isLoading && !submitting;
  const showConfidence = !!selectedOption && !isLoading;
  const showSubmit = showConfidence && !!confidence;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">

        {/* ── Question badge strip ── */}
        {(question.isTransferQuestion || question.isResetQuestion) && (
          <div
            className={cn(
              'px-5 py-2 text-xs font-semibold tracking-wide uppercase',
              question.isTransferQuestion
                ? 'bg-purple-50 text-purple-700 border-b border-purple-100'
                : 'bg-teal-50 text-teal-700 border-b border-teal-100',
            )}
          >
            {question.isTransferQuestion ? t.badge_transfer : t.badge_reset}
          </div>
        )}

        <div className="p-5 sm:p-7 space-y-6">

          {isLoading ? (
            <SkeletonLoader />
          ) : (
            <>
              {/* ── Question text + TTS ── */}
              <div className="flex items-start gap-3">
                <p
                  id={`question-text-${question.questionId}`}
                  className="flex-1 text-[1.15rem] sm:text-[1.25rem] font-semibold text-slate-800 leading-relaxed"
                >
                  {question.questionText}
                </p>
                <TtsButton
                  text={question.questionText}
                  lang={ttsLang}
                  disabled={isLoading || submitting}
                />
              </div>

              {/* ── Answer options ── */}
              <div
                role="group"
                aria-labelledby={`question-text-${question.questionId}`}
                className="space-y-3"
              >
                {OPTION_KEYS.map((key) => (
                  <OptionButton
                    key={key}
                    letter={key}
                    text={question.options[key]}
                    selected={selectedOption === key}
                    disabled={isLoading || submitting}
                    onClick={() => handleOptionClick(key)}
                  />
                ))}
              </div>

              {/* ── Confidence section — appears after selection ── */}
              <div
                className={cn(
                  'overflow-hidden transition-all duration-300 ease-in-out',
                  showConfidence
                    ? 'max-h-40 opacity-100'
                    : 'max-h-0 opacity-0 pointer-events-none',
                )}
                aria-hidden={!showConfidence}
              >
                <div className="pt-1 space-y-3">
                  <p className="text-sm font-medium text-slate-500">
                    {t.howConfident}
                  </p>
                  <div
                    role="group"
                    aria-label="Confidence level"
                    className="flex gap-2"
                  >
                    <ConfidenceButton
                      level="guessed"
                      label={t.guessed}
                      emoji="🎲"
                      selected={confidence === 'guessed'}
                      disabled={isLoading || submitting}
                      onClick={() => handleConfidenceClick('guessed')}
                    />
                    <ConfidenceButton
                      level="unsure"
                      label={t.unsure}
                      emoji="🤔"
                      selected={confidence === 'unsure'}
                      disabled={isLoading || submitting}
                      onClick={() => handleConfidenceClick('unsure')}
                    />
                    <ConfidenceButton
                      level="knew"
                      label={t.knew}
                      emoji="✓"
                      selected={confidence === 'knew'}
                      disabled={isLoading || submitting}
                      onClick={() => handleConfidenceClick('knew')}
                    />
                  </div>
                </div>
              </div>

              {/* ── Submit button — appears after confidence selected ── */}
              <div
                className={cn(
                  'transition-all duration-200 ease-in-out',
                  showSubmit
                    ? 'opacity-100 translate-y-0'
                    : 'opacity-0 translate-y-2 pointer-events-none',
                )}
                aria-hidden={!showSubmit}
              >
                <button
                  type="button"
                  id="submit-answer-button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className={cn(
                    'w-full py-4 rounded-xl text-base font-semibold',
                    'transition-all duration-200 active:scale-[0.98]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
                    canSubmit
                      ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md shadow-blue-200'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed',
                  )}
                >
                  {submitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg
                        className="w-4 h-4 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8v8H4z"
                        />
                      </svg>
                      {t.submitting}
                    </span>
                  ) : (
                    t.submit
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
