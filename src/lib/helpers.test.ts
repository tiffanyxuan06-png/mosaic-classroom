import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's TypeScript test runner requires the source extension.
import {
  calculatePersistenceScore,
  calculateTier,
  checkFrustrationThreshold,
  getNextQuestionParams,
  handleCorrectAnswer,
  type Answer,
  type StudentProgress,
} from './helpers.ts';

const baseProgress: StudentProgress = {
  studentUid: 'student-1',
  classId: 'class-1',
  topic: 'fractions',
  tier: 'green',
  activeMisconceptions: [],
  masteryScore: 70,
  consecutiveCorrect: 0,
  transferPassed: false,
};

const answer: Answer = {
  studentUid: 'student-1',
  classId: 'class-1',
  topic: 'fractions',
  isCorrect: true,
  isTransferQuestion: false,
  misconceptionId: 'frac_add_denom',
  confidenceLevel: 'knew',
};

test('calculateTier prioritises foundational and persistent misconceptions', () => {
  assert.equal(
    calculateTier({
      ...baseProgress,
      activeMisconceptions: [
        { misconceptionId: 'frac_equiv', severity: 'foundational', occurrenceCount: 1, persistenceScore: 1, lastSeen: 0, isCleared: false, prerequisite_misconception_id: null },
      ],
    }),
    'red',
  );
  assert.equal(
    calculateTier({
      ...baseProgress,
      activeMisconceptions: [
        { misconceptionId: 'frac_add_denom', severity: 'conceptual', occurrenceCount: 4, persistenceScore: 3.1, lastSeen: 0, isCleared: false, prerequisite_misconception_id: null },
      ],
    }),
    'red',
  );
});

test('calculateTier returns yellow, blue, and green for remaining states', () => {
  assert.equal(
    calculateTier({
      ...baseProgress,
      activeMisconceptions: [
        { misconceptionId: 'frac_add_denom', severity: 'conceptual', occurrenceCount: 1, persistenceScore: 1, lastSeen: 0, isCleared: false, prerequisite_misconception_id: null },
      ],
    }),
    'yellow',
  );
  assert.equal(calculateTier({ ...baseProgress, masteryScore: 80, consecutiveCorrect: 3, transferPassed: true }), 'blue');
  assert.equal(calculateTier(baseProgress), 'green');
});

test('calculatePersistenceScore applies seven-day recency decay and protects zero sessions', () => {
  const originalNow = Date.now;
  Date.now = () => 7 * 86_400_000;
  try {
    assert.equal(calculatePersistenceScore(6, 0, 2), 0);
    assert.equal(calculatePersistenceScore(6, 6 * 86_400_000, 0), 36 / 7);
  } finally {
    Date.now = originalNow;
  }
});

test('checkFrustrationThreshold requires four matching wrong answers among the latest four', () => {
  const wrong: Answer = { ...answer, isCorrect: false };
  assert.equal(checkFrustrationThreshold([wrong, wrong, wrong, wrong], 'frac_add_denom'), true);
  assert.equal(checkFrustrationThreshold([wrong, wrong, wrong, { ...wrong, misconceptionId: 'frac_equiv' }, wrong], 'frac_add_denom'), false);
});

test('handleCorrectAnswer chooses verification, confirmation, transfer, clearance, or practice', () => {
  assert.deepEqual(handleCorrectAnswer({ ...answer, confidenceLevel: 'guessed' }, baseProgress), { nextAction: 'serve_verification' });
  assert.deepEqual(handleCorrectAnswer({ ...answer, confidenceLevel: 'unsure' }, baseProgress), { nextAction: 'serve_confirmation' });
  assert.deepEqual(handleCorrectAnswer(answer, { ...baseProgress, consecutiveCorrect: 2 }), { nextAction: 'serve_transfer_question', misconceptionId: 'frac_add_denom' });
  assert.deepEqual(handleCorrectAnswer({ ...answer, isTransferQuestion: true }, { ...baseProgress, consecutiveCorrect: 3 }), { nextAction: 'clear_misconception', misconceptionId: 'frac_add_denom' });
  assert.deepEqual(handleCorrectAnswer(answer, baseProgress), { nextAction: 'continue_practice' });
});

test('getNextQuestionParams routes prerequisites, resets frustration, serves transfers, and derives difficulty from tier', () => {
  const active = { misconceptionId: 'frac_add_denom', severity: 'conceptual' as const, occurrenceCount: 2, persistenceScore: 2, lastSeen: 0, isCleared: false, prerequisite_misconception_id: 'frac_equiv' };
  const prerequisite = { misconceptionId: 'frac_equiv', severity: 'foundational' as const, occurrenceCount: 1, persistenceScore: 1, lastSeen: 0, isCleared: false, prerequisite_misconception_id: null };
  assert.deepEqual(getNextQuestionParams({ ...baseProgress, tier: 'red', activeMisconceptions: [active, prerequisite] }, []), { misconceptionId: 'frac_equiv', difficulty: 1, isTransferQuestion: false, isResetQuestion: false });
  assert.equal(getNextQuestionParams({ ...baseProgress, tier: 'yellow', activeMisconceptions: [active] }, [{ ...answer, isCorrect: false }, { ...answer, isCorrect: false }, { ...answer, isCorrect: false }, { ...answer, isCorrect: false }]).isResetQuestion, true);
  assert.deepEqual(getNextQuestionParams({ ...baseProgress, tier: 'blue', consecutiveCorrect: 3, activeMisconceptions: [active] }, []), { misconceptionId: 'frac_add_denom', difficulty: 3, isTransferQuestion: true, isResetQuestion: false });
});
