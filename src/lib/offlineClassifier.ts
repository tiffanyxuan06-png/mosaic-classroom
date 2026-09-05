'use client';

import { supabase } from '@/lib/supabase-client';

// ─────────────────────────────────────────────────────────────────────────────
// Offline misconception classification.
//
// /api/quiz/classify needs Gemini, so it can't run without a connection. The
// misconception catalogue is small, public reference data, so it's cached in
// localStorage on first load and matched against locally with the same
// wrong_answer_pattern text the model is given. Coarser than the model, but it
// keeps the diagnosis loop running through a wifi drop — and every answer is
// still queued, so the server reclassifies it authoritatively on sync.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_KEY = 'mosaic.misconceptionCatalogue.v1';

export interface CachedMisconception {
  misconceptionId: string;
  subject: string;
  topic: string;
  name: string;
  wrong_answer_pattern: string;
}

export interface LocalClassification {
  misconceptionId: string;
  confidence: 'medium' | 'low';
  reasoning: string;
  /** Always true here — lets callers mark the result as provisional. */
  offline: true;
}

/** Caches the catalogue so it survives losing the connection mid-lesson. */
export async function cacheMisconceptionCatalogue(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('misconceptions')
      .select('id, subject, topic, name, wrong_answer_pattern');

    if (error || !data) return;

    const entries: CachedMisconception[] = data.map((row) => ({
      misconceptionId: row.id as string,
      subject: (row.subject as string) ?? '',
      topic: (row.topic as string) ?? '',
      name: (row.name as string) ?? (row.id as string),
      wrong_answer_pattern: (row.wrong_answer_pattern as string) ?? '',
    }));

    localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch (err) {
    console.error('[offlineClassifier] cache failed', err);
  }
}

export function readCachedCatalogue(): CachedMisconception[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedMisconception[]) : [];
  } catch {
    return [];
  }
}

/** Word-overlap score between the student's answer and a pattern description. */
function overlapScore(pattern: string, studentAnswer: string, questionText: string): number {
  const patternWords = pattern
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);

  if (patternWords.length === 0) return 0;

  const haystack = `${studentAnswer} ${questionText}`.toLowerCase();
  const hits = patternWords.filter((w) => haystack.includes(w)).length;
  return hits / patternWords.length;
}

/**
 * Best-effort local classification. Prefers a misconception whose
 * wrong_answer_pattern overlaps the student's answer; otherwise falls back to
 * the first misconception catalogued for that topic, so the student still gets
 * targeted practice rather than nothing.
 */
export function classifyOffline(input: {
  subject: string;
  topic: string;
  questionText: string;
  studentAnswer: string;
}): LocalClassification | null {
  const catalogue = readCachedCatalogue().filter(
    (m) =>
      m.topic.toLowerCase() === input.topic.toLowerCase() &&
      (!m.subject || m.subject.toLowerCase() === input.subject.toLowerCase()),
  );

  if (catalogue.length === 0) return null;

  const ranked = catalogue
    .map((m) => ({
      entry: m,
      score: overlapScore(m.wrong_answer_pattern, input.studentAnswer, input.questionText),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  if (best.score > 0) {
    return {
      misconceptionId: best.entry.misconceptionId,
      confidence: 'medium',
      reasoning: `Offline match on error pattern: ${best.entry.name}`,
      offline: true,
    };
  }

  return {
    misconceptionId: catalogue[0].misconceptionId,
    confidence: 'low',
    reasoning: 'Offline fallback — most common misconception for this topic.',
    offline: true,
  };
}
