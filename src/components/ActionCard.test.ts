import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's TypeScript runner requires the source extension.
import { aggregateTopMisconceptions } from './ActionCard.tsx';

test('aggregateTopMisconceptions counts each affected student once and sorts by urgency', () => {
  const summaries = aggregateTopMisconceptions([
    {
      studentUid: 'student-1',
      activeMisconceptions: [
        { misconceptionId: 'frac_add_denom', persistenceScore: 2, isCleared: false },
        { misconceptionId: 'frac_add_denom', persistenceScore: 1, isCleared: false },
      ],
    },
    {
      studentUid: 'student-2',
      activeMisconceptions: [
        { misconceptionId: 'frac_equiv', persistenceScore: 3, isCleared: false },
        { misconceptionId: 'frac_add_denom', persistenceScore: 1, isCleared: true },
      ],
    },
  ]);

  assert.deepEqual(summaries, [
    {
      misconceptionId: 'frac_equiv',
      misconceptionName: 'frac_equiv',
      studentCount: 1,
      persistenceScore: 3,
    },
    {
      misconceptionId: 'frac_add_denom',
      misconceptionName: 'frac_add_denom',
      studentCount: 1,
      persistenceScore: 2,
    },
  ]);
});
