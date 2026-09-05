import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's TypeScript test runner requires the source extension.
import { REPEAT_ALERT_THRESHOLD, MAX_LEARNERS_PER_TUTOR, clusterByMisconception, findRepeatAlerts, hasRepeatAlert, buildPeerTutorPairs, misconceptionLabel, misconceptionShortLabel, studentName, type ClassContext } from './classInsights.ts';
import type { ActiveMisconception, StudentProgress } from './helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function misconception(
  misconceptionId: string,
  overrides: Partial<ActiveMisconception> = {},
): ActiveMisconception {
  return {
    misconceptionId,
    severity: 'conceptual',
    occurrenceCount: 1,
    persistenceScore: 1,
    lastSeen: 1_000,
    isCleared: false,
    prerequisite_misconception_id: null,
    ...overrides,
  };
}

function progress(
  studentUid: string,
  topic: string,
  activeMisconceptions: ActiveMisconception[],
  overrides: Partial<StudentProgress> = {},
): StudentProgress {
  return {
    studentUid,
    classId: 'class-1',
    topic,
    tier: 'yellow',
    activeMisconceptions,
    masteryScore: 50,
    consecutiveCorrect: 0,
    transferPassed: false,
    sessionsActive: 1,
    ...overrides,
  };
}

const context: ClassContext = {
  studentNames: new Map([
    ['uid-hana', 'Hana'],
    ['uid-adam', 'Adam'],
    ['uid-siti', 'Siti'],
  ]),
  misconceptions: new Map([
    [
      'frac_add_denom',
      {
        name: 'Adding denominators directly',
        name_bm: 'Menambah penyebut terus',
        plainLanguageLabel: 'Adds the bottom numbers as well as the top ones',
        plainLanguageLabel_bm: 'Menambah nombor bawah juga',
        remediationApproach: 'Use a common-denominator strip model.',
      },
    ],
  ]),
};

// ─────────────────────────────────────────────────────────────────────────────
// Label / name resolution
// ─────────────────────────────────────────────────────────────────────────────

test('labels fall back to a de-slugged id when the catalogue lacks the entry', () => {
  assert.equal(
    misconceptionLabel('frac_add_denom', context),
    'Adds the bottom numbers as well as the top ones',
  );
  assert.equal(misconceptionShortLabel('frac_add_denom', context), 'Adding denominators directly');
  assert.equal(misconceptionShortLabel('frac_add_denom', context, 'bm'), 'Menambah penyebut terus');
  // Unknown id must never leak a raw slug with underscores to a teacher.
  assert.equal(misconceptionLabel('dec_place_value', context), 'dec place value');
});

test('student names fall back to the uid when the roster has not loaded', () => {
  assert.equal(studentName('uid-hana', context), 'Hana');
  assert.equal(studentName('uid-unknown', context), 'uid-unknown');
});

// ─────────────────────────────────────────────────────────────────────────────
// Clustering
// ─────────────────────────────────────────────────────────────────────────────

test('clusterByMisconception groups students sharing an error, biggest group first', () => {
  const clusters = clusterByMisconception(
    [
      progress('uid-hana', 'fractions', [misconception('frac_add_denom')]),
      progress('uid-siti', 'fractions', [misconception('frac_add_denom')]),
      progress('uid-adam', 'decimals', [misconception('dec_comparison')]),
    ],
    context,
  );

  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].misconceptionId, 'frac_add_denom');
  assert.equal(clusters[0].students.length, 2);
  assert.deepEqual(
    clusters[0].students.map((s) => s.name).sort(),
    ['Hana', 'Siti'],
  );
  assert.equal(clusters[0].remediationApproach, 'Use a common-denominator strip model.');
  assert.equal(clusters[1].students.length, 1);
});

test('clusterByMisconception ignores cleared misconceptions', () => {
  const clusters = clusterByMisconception(
    [
      progress('uid-adam', 'fractions', [
        misconception('frac_add_denom', { isCleared: true }),
      ]),
    ],
    context,
  );

  assert.deepEqual(clusters, []);
});

test('a student hitting one misconception across two topics is counted once, keeping the worst', () => {
  const clusters = clusterByMisconception(
    [
      progress('uid-hana', 'fractions', [
        misconception('frac_add_denom', { persistenceScore: 1, occurrenceCount: 1 }),
      ]),
      progress('uid-hana', 'decimals', [
        misconception('frac_add_denom', { persistenceScore: 4, occurrenceCount: 5 }),
      ]),
    ],
    context,
  );

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].students.length, 1);
  assert.equal(clusters[0].students[0].persistenceScore, 4);
  assert.equal(clusters[0].students[0].occurrenceCount, 5);
  assert.deepEqual(clusters[0].topics, ['decimals', 'fractions']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Repeat alerts
// ─────────────────────────────────────────────────────────────────────────────

test('findRepeatAlerts fires only at the threshold, and only for uncleared errors', () => {
  const alerts = findRepeatAlerts(
    [
      progress('uid-hana', 'fractions', [
        misconception('frac_add_denom', { occurrenceCount: REPEAT_ALERT_THRESHOLD }),
      ]),
      // One below the threshold — not yet an intervention.
      progress('uid-siti', 'fractions', [
        misconception('frac_add_denom', { occurrenceCount: REPEAT_ALERT_THRESHOLD - 1 }),
      ]),
      // Repeated, but already beaten — no longer a problem.
      progress('uid-adam', 'fractions', [
        misconception('frac_add_denom', { occurrenceCount: 9, isCleared: true }),
      ]),
    ],
    context,
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].studentName, 'Hana');
  assert.equal(alerts[0].occurrenceCount, REPEAT_ALERT_THRESHOLD);
  assert.equal(alerts[0].label, 'Adding denominators directly');
});

test('findRepeatAlerts surfaces the most recent trigger first', () => {
  const alerts = findRepeatAlerts(
    [
      progress('uid-hana', 'fractions', [
        misconception('frac_add_denom', { occurrenceCount: 4, lastSeen: 100 }),
      ]),
      progress('uid-siti', 'fractions', [
        misconception('frac_add_denom', { occurrenceCount: 4, lastSeen: 900 }),
      ]),
    ],
    context,
  );

  assert.deepEqual(alerts.map((a) => a.studentName), ['Siti', 'Hana']);
});

test('hasRepeatAlert reflects whether any uncleared error hit the threshold', () => {
  assert.equal(hasRepeatAlert([misconception('m', { occurrenceCount: 3 })]), true);
  assert.equal(hasRepeatAlert([misconception('m', { occurrenceCount: 2 })]), false);
  assert.equal(
    hasRepeatAlert([misconception('m', { occurrenceCount: 9, isCleared: true })]),
    false,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Peer tutoring
// ─────────────────────────────────────────────────────────────────────────────

test('buildPeerTutorPairs matches a student who cleared the error with one still stuck', () => {
  const pairs = buildPeerTutorPairs(
    [
      progress('uid-adam', 'fractions', [
        misconception('frac_add_denom', { isCleared: true }),
      ]),
      progress('uid-hana', 'fractions', [misconception('frac_add_denom')]),
    ],
    context,
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].tutor.name, 'Adam');
  assert.equal(pairs[0].tutor.evidence, 'cleared');
  assert.equal(pairs[0].learner.name, 'Hana');
  assert.equal(pairs[0].label, 'Adding denominators directly');
});

test('buildPeerTutorPairs never pairs a student with themselves', () => {
  // Same student cleared it on one topic and is stuck on it in another.
  const pairs = buildPeerTutorPairs(
    [
      progress('uid-hana', 'fractions', [
        misconception('frac_add_denom', { isCleared: true }),
      ]),
      progress('uid-hana', 'decimals', [misconception('frac_add_denom')]),
    ],
    context,
  );

  assert.deepEqual(pairs, []);
});

test('buildPeerTutorPairs caps how many learners one tutor is given', () => {
  const stuck = ['uid-a', 'uid-b', 'uid-c', 'uid-d'].map((uid) =>
    progress(uid, 'fractions', [misconception('frac_add_denom')]),
  );

  const pairs = buildPeerTutorPairs(
    [
      progress('uid-adam', 'fractions', [
        misconception('frac_add_denom', { isCleared: true }),
      ]),
      ...stuck,
    ],
    context,
  );

  assert.equal(pairs.length, MAX_LEARNERS_PER_TUTOR);
  assert.ok(pairs.every((p) => p.tutor.uid === 'uid-adam'));
});

test('the most stuck learner is paired first, since tutors are the scarce resource', () => {
  const pairs = buildPeerTutorPairs(
    [
      progress('uid-adam', 'fractions', [
        misconception('frac_add_denom', { isCleared: true }),
      ]),
      progress('uid-hana', 'fractions', [
        misconception('frac_add_denom', { persistenceScore: 5 }),
      ]),
      progress('uid-siti', 'fractions', [
        misconception('frac_add_denom', { persistenceScore: 1 }),
      ]),
    ],
    context,
  );

  assert.equal(pairs[0].learner.name, 'Hana');
});

test('no pairing is invented when nobody has beaten the misconception', () => {
  const pairs = buildPeerTutorPairs(
    [
      progress('uid-hana', 'fractions', [misconception('frac_add_denom')]),
      progress('uid-siti', 'fractions', [misconception('frac_add_denom')]),
    ],
    context,
  );

  assert.deepEqual(pairs, []);
});
