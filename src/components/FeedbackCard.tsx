'use client';

import { motion, AnimatePresence } from 'framer-motion';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ConfidenceLevel = 'guessed' | 'unsure' | 'knew';

export interface FeedbackCardProps {
  isCorrect: boolean;
  misconceptionId: string | null;
  misconceptionLabel: string | null;
  misconceptionLabel_bm: string | null;
  isTransferQuestion: boolean;
  isResetQuestion: boolean;
  confidenceLevel: ConfidenceLevel;
  language: 'en' | 'bm';
  onNext: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant config — one object drives all conditional styling & copy
// ─────────────────────────────────────────────────────────────────────────────

type Variant =
  | 'mastered'      // correct + knew + transfer
  | 'correct_knew'  // correct + knew (standard)
  | 'correct_unsure'
  | 'correct_guessed'
  | 'incorrect'
  | 'reset';

function resolveVariant(
  isCorrect: boolean,
  isTransferQuestion: boolean,
  isResetQuestion: boolean,
  confidenceLevel: ConfidenceLevel,
): Variant {
  if (isResetQuestion) return 'reset';
  if (isCorrect && confidenceLevel === 'knew' && isTransferQuestion) return 'mastered';
  if (isCorrect && confidenceLevel === 'knew') return 'correct_knew';
  if (isCorrect && confidenceLevel === 'unsure') return 'correct_unsure';
  if (isCorrect && confidenceLevel === 'guessed') return 'correct_guessed';
  return 'incorrect';
}

interface VariantTheme {
  /** Outer card bg + border */
  card: string;
  /** Icon circle bg */
  iconCircle: string;
  /** Icon symbol */
  icon: string;
  /** Headline text colour */
  headlineColor: string;
  /** Body text colour */
  bodyColor: string;
  /** Next-button colours */
  button: string;
}

const THEMES: Record<Variant, VariantTheme> = {
  mastered: {
    card: 'bg-green-50 border-green-200',
    iconCircle: 'bg-green-100',
    icon: '✓',
    headlineColor: 'text-green-800',
    bodyColor: 'text-green-700',
    button: 'bg-green-600 hover:bg-green-700 shadow-green-200 text-white',
  },
  correct_knew: {
    card: 'bg-green-50 border-green-200',
    iconCircle: 'bg-green-100',
    icon: '✓',
    headlineColor: 'text-green-800',
    bodyColor: 'text-green-700',
    button: 'bg-green-600 hover:bg-green-700 shadow-green-200 text-white',
  },
  correct_unsure: {
    card: 'bg-teal-50 border-teal-200',
    iconCircle: 'bg-teal-100',
    icon: '✓',
    headlineColor: 'text-teal-800',
    bodyColor: 'text-teal-700',
    button: 'bg-teal-600 hover:bg-teal-700 shadow-teal-200 text-white',
  },
  correct_guessed: {
    card: 'bg-amber-50 border-amber-200',
    iconCircle: 'bg-amber-100',
    icon: '✓',
    headlineColor: 'text-amber-800',
    bodyColor: 'text-amber-700',
    button: 'bg-amber-500 hover:bg-amber-600 shadow-amber-200 text-white',
  },
  incorrect: {
    card: 'bg-rose-50 border-rose-200',
    iconCircle: 'bg-rose-100',
    icon: '○',
    headlineColor: 'text-rose-800',
    bodyColor: 'text-rose-700',
    button: 'bg-rose-500 hover:bg-rose-600 shadow-rose-200 text-white',
  },
  reset: {
    card: 'bg-blue-50 border-blue-200',
    iconCircle: 'bg-blue-100',
    icon: '↺',
    headlineColor: 'text-blue-800',
    bodyColor: 'text-blue-700',
    button: 'bg-blue-600 hover:bg-blue-700 shadow-blue-200 text-white',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Copy strings
// ─────────────────────────────────────────────────────────────────────────────

const COPY = {
  en: {
    mastered_headline: 'Correct! You\'ve mastered this concept.',
    mastered_body: 'Misconception cleared — outstanding work!',
    correct_knew_headline: 'Correct! Well done.',
    correct_unsure_headline: 'Correct! Let\'s do one more to confirm.',
    correct_guessed_headline: 'Correct — but you guessed!',
    correct_guessed_body: 'Let\'s verify your understanding with another question.',
    incorrect_headline: 'Not quite — let\'s understand why.',
    incorrect_thinking: 'You might be thinking:',
    incorrect_encourage:
      'This is a common pattern — the next question will help you correct it.',
    reset_headline: 'Great! Let\'s come back to this from a fresh angle.',
    next: 'Next Question →',
  },
  bm: {
    mastered_headline: 'Betul! Anda telah menguasai konsep ini.',
    mastered_body: 'Salah faham telah diperbetulkan — kerja yang cemerlang!',
    correct_knew_headline: 'Betul! Bagus sekali.',
    correct_unsure_headline: 'Betul! Jom cuba satu lagi untuk sahkan.',
    correct_guessed_headline: 'Betul — tetapi anda meneka!',
    correct_guessed_body:
      'Jom sahkan pemahaman anda dengan soalan lain.',
    incorrect_headline: 'Hampir betul — jom faham kenapa.',
    incorrect_thinking: 'Anda mungkin fikir:',
    incorrect_encourage:
      'Ini adalah corak yang biasa — soalan seterusnya akan membantu anda membetulkannya.',
    reset_headline: 'Bagus! Jom kembali kepada topik ini dari sudut yang segar.',
    next: 'Soalan Seterusnya →',
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Sparkling mastery animation
// ─────────────────────────────────────────────────────────────────────────────

function SparkleRing() {
  const sparks = [0, 45, 90, 135, 180, 225, 270, 315];

  return (
    <div className="relative inline-flex items-center justify-center">
      {/* Rotating spark ring */}
      <motion.div
        className="absolute inset-0"
        animate={{ rotate: 360 }}
        transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
      >
        {sparks.map((deg) => (
          <motion.span
            key={deg}
            className="absolute text-yellow-400 text-xs select-none"
            style={{
              top: '50%',
              left: '50%',
              transformOrigin: '0 0',
              transform: `rotate(${deg}deg) translateY(-28px)`,
            }}
            animate={{ opacity: [0.4, 1, 0.4], scale: [0.8, 1.2, 0.8] }}
            transition={{
              duration: 1.6,
              repeat: Infinity,
              delay: (deg / 360) * 1.6,
              ease: 'easeInOut',
            }}
          >
            ✦
          </motion.span>
        ))}
      </motion.div>

      {/* Centre icon */}
      <span className="relative z-10 text-2xl">✨</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Misconception highlight box
// ─────────────────────────────────────────────────────────────────────────────

function MisconceptionBox({
  label,
  thinkingText,
}: {
  label: string;
  thinkingText: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.35, duration: 0.3 }}
      className="mt-3 rounded-xl border border-rose-200 bg-white/70 px-4 py-3"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-rose-400 mb-1">
        {thinkingText}
      </p>
      <p className="text-sm font-medium text-rose-800 leading-snug">
        "{label}"
      </p>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function FeedbackCard({
  isCorrect,
  misconceptionId: _misconceptionId,
  misconceptionLabel,
  misconceptionLabel_bm,
  isTransferQuestion,
  isResetQuestion,
  confidenceLevel,
  language,
  onNext,
}: FeedbackCardProps) {
  const t = COPY[language];
  const variant = resolveVariant(
    isCorrect,
    isTransferQuestion,
    isResetQuestion,
    confidenceLevel,
  );
  const theme = THEMES[variant];

  // Resolve the misconception label to show based on language
  const activeMisconceptionLabel =
    language === 'bm' ? misconceptionLabel_bm : misconceptionLabel;

  // ── Headline + body copy ──────────────────────────────────────────────────
  let headline = '';
  let body: string | null = null;
  let showMisconception = false;

  switch (variant) {
    case 'mastered':
      headline = t.mastered_headline;
      body = t.mastered_body;
      break;
    case 'correct_knew':
      headline = t.correct_knew_headline;
      break;
    case 'correct_unsure':
      headline = t.correct_unsure_headline;
      break;
    case 'correct_guessed':
      headline = t.correct_guessed_headline;
      body = t.correct_guessed_body;
      break;
    case 'incorrect':
      headline = t.incorrect_headline;
      body = t.incorrect_encourage;
      showMisconception = !!activeMisconceptionLabel;
      break;
    case 'reset':
      headline = t.reset_headline;
      break;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={variant}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -16 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-2xl mx-auto"
      >
        <div
          className={cn(
            'rounded-2xl border-2 overflow-hidden shadow-sm',
            theme.card,
          )}
        >
          <div className="px-5 py-6 sm:px-7 sm:py-7 space-y-5">

            {/* ── Icon + headline row ── */}
            <div className="flex items-start gap-4">
              {/* Icon circle */}
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.08, type: 'spring', stiffness: 300, damping: 18 }}
                className={cn(
                  'flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center',
                  'text-xl font-bold select-none',
                  theme.iconCircle,
                  theme.headlineColor,
                )}
                aria-hidden="true"
              >
                {theme.icon}
              </motion.div>

              {/* Headline + mastery sparkle */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h2
                    className={cn(
                      'text-lg sm:text-xl font-bold leading-snug',
                      theme.headlineColor,
                    )}
                  >
                    {headline}
                  </h2>

                  {/* Sparkle ring only for mastered variant */}
                  {variant === 'mastered' && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.3, type: 'spring', stiffness: 260 }}
                    >
                      <SparkleRing />
                    </motion.div>
                  )}
                </div>

                {/* Body copy */}
                {body && (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.22 }}
                    className={cn('mt-1.5 text-sm leading-relaxed', theme.bodyColor)}
                  >
                    {body}
                  </motion.p>
                )}
              </div>
            </div>

            {/* ── Misconception box (incorrect only) ── */}
            {showMisconception && activeMisconceptionLabel && (
              <MisconceptionBox
                label={activeMisconceptionLabel}
                thinkingText={t.incorrect_thinking}
              />
            )}

            {/* ── Divider ── */}
            <motion.hr
              initial={{ scaleX: 0, opacity: 0 }}
              animate={{ scaleX: 1, opacity: 1 }}
              transition={{ delay: 0.3, duration: 0.4 }}
              className={cn(
                'border-0 border-t origin-left',
                variant === 'incorrect' ? 'border-rose-200' :
                variant === 'reset' ? 'border-blue-200' :
                variant === 'correct_guessed' ? 'border-amber-200' :
                variant === 'correct_unsure' ? 'border-teal-200' :
                'border-green-200',
              )}
            />

            {/* ── Next button ── */}
            <motion.button
              type="button"
              id="next-question-button"
              onClick={onNext}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4, duration: 0.25 }}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              className={cn(
                'w-full py-3.5 rounded-xl text-base font-semibold',
                'transition-colors duration-150 shadow-md',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-current',
                theme.button,
              )}
            >
              {t.next}
            </motion.button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
