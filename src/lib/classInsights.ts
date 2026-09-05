import type {
  ActiveMisconception,
  MisconceptionSeverity,
  StudentProgress,
} from '@/lib/helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Shared class-level analytics: the "why" layer that turns raw per-topic
// progress rows into misconception-typology views — clusters for small-group
// intervention, and repeat alerts for same-lesson triage.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A student who hits the same misconception this many times without clearing
 * it is stuck on it, not just guessing — that's the point where a teacher
 * should intervene rather than let the adaptive sequence keep trying.
 */
export const REPEAT_ALERT_THRESHOLD = 3;

/** Catalogue entry, keyed by misconceptionId, used to resolve display text. */
export interface MisconceptionMeta {
  name: string;
  plainLanguageLabel: string | null;
  plainLanguageLabel_bm: string | null;
  name_bm: string | null;
  remediationApproach: string | null;
}

export interface ClassContext {
  /** studentUid → display name. */
  studentNames: Map<string, string>;
  /** misconceptionId → catalogue metadata. */
  misconceptions: Map<string, MisconceptionMeta>;
}

export const EMPTY_CLASS_CONTEXT: ClassContext = {
  studentNames: new Map(),
  misconceptions: new Map(),
};

/**
 * Human-readable misconception label. Falls back to de-slugging the id so the
 * UI never shows a raw `frac_add_denom` to a teacher mid-lesson.
 */
export function misconceptionLabel(
  misconceptionId: string,
  context: ClassContext,
  language: 'en' | 'bm' = 'en',
): string {
  const meta = context.misconceptions.get(misconceptionId);
  if (!meta) return misconceptionId.replace(/_/g, ' ');

  if (language === 'bm') {
    return meta.plainLanguageLabel_bm ?? meta.name_bm ?? meta.plainLanguageLabel ?? meta.name;
  }
  return meta.plainLanguageLabel ?? meta.name;
}

/** Short label for tight spaces (heatmap cells, chips) — prefers the catalogue name. */
export function misconceptionShortLabel(
  misconceptionId: string,
  context: ClassContext,
  language: 'en' | 'bm' = 'en',
): string {
  const meta = context.misconceptions.get(misconceptionId);
  if (!meta) return misconceptionId.replace(/_/g, ' ');
  return language === 'bm' ? meta.name_bm ?? meta.name : meta.name;
}

export function studentName(studentUid: string, context: ClassContext): string {
  return context.studentNames.get(studentUid) ?? studentUid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repeat alerts — claim #4: same-lesson triage
// ─────────────────────────────────────────────────────────────────────────────

export interface RepeatAlert {
  studentUid: string;
  studentName: string;
  misconceptionId: string;
  label: string;
  topic: string;
  severity: MisconceptionSeverity;
  occurrenceCount: number;
  persistenceScore: number;
  lastSeen: number;
}

/** Stable identity for an alert, so the UI can tell new ones from seen ones. */
export function repeatAlertKey(alert: {
  studentUid: string;
  misconceptionId: string;
  topic: string;
}): string {
  return `${alert.studentUid}::${alert.topic}::${alert.misconceptionId}`;
}

/**
 * Every uncleared misconception a student has repeated at least
 * REPEAT_ALERT_THRESHOLD times. Sorted most-recent-first so the teacher sees
 * what just happened at the top.
 */
export function findRepeatAlerts(
  rows: StudentProgress[],
  context: ClassContext,
  language: 'en' | 'bm' = 'en',
): RepeatAlert[] {
  const alerts: RepeatAlert[] = [];

  for (const row of rows) {
    for (const misconception of row.activeMisconceptions) {
      if (misconception.isCleared) continue;
      if (misconception.occurrenceCount < REPEAT_ALERT_THRESHOLD) continue;

      alerts.push({
        studentUid: row.studentUid,
        studentName: studentName(row.studentUid, context),
        misconceptionId: misconception.misconceptionId,
        label: misconceptionShortLabel(misconception.misconceptionId, context, language),
        topic: row.topic,
        severity: misconception.severity,
        occurrenceCount: misconception.occurrenceCount,
        persistenceScore: misconception.persistenceScore,
        lastSeen: misconception.lastSeen,
      });
    }
  }

  return alerts.sort((a, b) => b.lastSeen - a.lastSeen);
}

/** True if this cell/student has any misconception at or past the threshold. */
export function hasRepeatAlert(misconceptions: ActiveMisconception[]): boolean {
  return misconceptions.some(
    (m) => !m.isCleared && m.occurrenceCount >= REPEAT_ALERT_THRESHOLD,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Misconception clustering — claim #5: automated small-group formation
// ─────────────────────────────────────────────────────────────────────────────

export interface ClusterMember {
  uid: string;
  name: string;
  topic: string;
  occurrenceCount: number;
  persistenceScore: number;
  repeatAlert: boolean;
}

export interface MisconceptionCluster {
  misconceptionId: string;
  label: string;
  shortLabel: string;
  severity: MisconceptionSeverity;
  /** Topics this misconception showed up in across the class. */
  topics: string[];
  students: ClusterMember[];
  maxPersistence: number;
  repeatAlertCount: number;
  remediationApproach: string | null;
}

/**
 * Groups the class by shared misconception rather than by score tier, so a
 * teacher gets ready-made small groups ("4 students adding denominators
 * directly") instead of a list of who scored badly.
 *
 * A student appearing in the same misconception across two topics is counted
 * once, keeping their strongest (most persistent) occurrence.
 */
export function clusterByMisconception(
  rows: StudentProgress[],
  context: ClassContext,
  language: 'en' | 'bm' = 'en',
): MisconceptionCluster[] {
  const clusters = new Map<
    string,
    {
      severity: MisconceptionSeverity;
      topics: Set<string>;
      byStudent: Map<string, ClusterMember>;
    }
  >();

  for (const row of rows) {
    for (const misconception of row.activeMisconceptions) {
      if (misconception.isCleared) continue;

      const cluster = clusters.get(misconception.misconceptionId) ?? {
        severity: misconception.severity,
        topics: new Set<string>(),
        byStudent: new Map<string, ClusterMember>(),
      };
      cluster.topics.add(row.topic);

      const existing = cluster.byStudent.get(row.studentUid);
      if (!existing || misconception.persistenceScore > existing.persistenceScore) {
        cluster.byStudent.set(row.studentUid, {
          uid: row.studentUid,
          name: studentName(row.studentUid, context),
          topic: row.topic,
          occurrenceCount: misconception.occurrenceCount,
          persistenceScore: misconception.persistenceScore,
          repeatAlert: misconception.occurrenceCount >= REPEAT_ALERT_THRESHOLD,
        });
      }

      clusters.set(misconception.misconceptionId, cluster);
    }
  }

  return [...clusters.entries()]
    .map(([misconceptionId, cluster]) => {
      const students = [...cluster.byStudent.values()].sort(
        (a, b) => b.persistenceScore - a.persistenceScore,
      );

      return {
        misconceptionId,
        label: misconceptionLabel(misconceptionId, context, language),
        shortLabel: misconceptionShortLabel(misconceptionId, context, language),
        severity: cluster.severity,
        topics: [...cluster.topics].sort(),
        students,
        maxPersistence: Math.max(0, ...students.map((s) => s.persistenceScore)),
        repeatAlertCount: students.filter((s) => s.repeatAlert).length,
        remediationApproach:
          context.misconceptions.get(misconceptionId)?.remediationApproach ?? null,
      };
    })
    .sort((a, b) => {
      // Biggest shared blocker first; break ties on how stuck the group is.
      if (b.students.length !== a.students.length) {
        return b.students.length - a.students.length;
      }
      return b.maxPersistence - a.maxPersistence;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Peer tutoring — pair a student who has beaten a misconception with one who
// is still stuck on it. Peer explanation works best when the tutor cleared
// the *same* error recently, because they still remember what confused them.
// ─────────────────────────────────────────────────────────────────────────────

/** A tutor shouldn't be handed the whole class — cap the pairing fan-out. */
export const MAX_LEARNERS_PER_TUTOR = 2;

export interface PeerTutorPair {
  misconceptionId: string;
  label: string;
  topic: string;
  tutor: {
    uid: string;
    name: string;
    /** `cleared` = beat this exact misconception; `mastered` = strong on the topic. */
    evidence: 'cleared' | 'mastered';
  };
  learner: {
    uid: string;
    name: string;
    occurrenceCount: number;
    persistenceScore: number;
    repeatAlert: boolean;
  };
}

/**
 * Builds tutor→learner pairs per misconception. Tutors who cleared the exact
 * misconception are preferred over generally-strong students; learners who are
 * most stuck are matched first so the scarcest resource (a capable peer) goes
 * where it helps most.
 */
export function buildPeerTutorPairs(
  rows: StudentProgress[],
  context: ClassContext,
  language: 'en' | 'bm' = 'en',
): PeerTutorPair[] {
  interface Candidate {
    uid: string;
    topic: string;
    evidence: 'cleared' | 'mastered';
  }

  const tutorsByMisconception = new Map<string, Candidate[]>();
  const learnersByMisconception = new Map<
    string,
    { uid: string; topic: string; occurrenceCount: number; persistenceScore: number }[]
  >();

  for (const row of rows) {
    const uncleared = row.activeMisconceptions.filter((m) => !m.isCleared);

    for (const misconception of row.activeMisconceptions) {
      if (misconception.isCleared) {
        const list = tutorsByMisconception.get(misconception.misconceptionId) ?? [];
        list.push({ uid: row.studentUid, topic: row.topic, evidence: 'cleared' });
        tutorsByMisconception.set(misconception.misconceptionId, list);
      } else {
        const list = learnersByMisconception.get(misconception.misconceptionId) ?? [];
        list.push({
          uid: row.studentUid,
          topic: row.topic,
          occurrenceCount: misconception.occurrenceCount,
          persistenceScore: misconception.persistenceScore,
        });
        learnersByMisconception.set(misconception.misconceptionId, list);
      }
    }

    // Students who are strong on a topic with nothing outstanding can tutor any
    // misconception in that topic, as a fallback when no exact-clearer exists.
    if (uncleared.length === 0 && (row.tier === 'blue' || row.tier === 'green')) {
      for (const [misconceptionId, learners] of learnersByMisconception) {
        if (!learners.some((l) => l.topic === row.topic)) continue;
        const list = tutorsByMisconception.get(misconceptionId) ?? [];
        list.push({ uid: row.studentUid, topic: row.topic, evidence: 'mastered' });
        tutorsByMisconception.set(misconceptionId, list);
      }
    }
  }

  const pairs: PeerTutorPair[] = [];
  const tutorLoad = new Map<string, number>();

  for (const [misconceptionId, learners] of learnersByMisconception) {
    const tutors = (tutorsByMisconception.get(misconceptionId) ?? [])
      // Exact clearers first — they know this specific trap.
      .sort((a, b) => (a.evidence === b.evidence ? 0 : a.evidence === 'cleared' ? -1 : 1));

    if (tutors.length === 0) continue;

    const rankedLearners = [...learners].sort(
      (a, b) => b.persistenceScore - a.persistenceScore,
    );

    for (const learner of rankedLearners) {
      const tutor = tutors.find(
        (t) =>
          t.uid !== learner.uid &&
          (tutorLoad.get(t.uid) ?? 0) < MAX_LEARNERS_PER_TUTOR,
      );
      if (!tutor) break;

      tutorLoad.set(tutor.uid, (tutorLoad.get(tutor.uid) ?? 0) + 1);

      pairs.push({
        misconceptionId,
        label: misconceptionShortLabel(misconceptionId, context, language),
        topic: learner.topic,
        tutor: {
          uid: tutor.uid,
          name: studentName(tutor.uid, context),
          evidence: tutor.evidence,
        },
        learner: {
          uid: learner.uid,
          name: studentName(learner.uid, context),
          occurrenceCount: learner.occurrenceCount,
          persistenceScore: learner.persistenceScore,
          repeatAlert: learner.occurrenceCount >= REPEAT_ALERT_THRESHOLD,
        },
      });
    }
  }

  // Most-stuck learners surface first so the teacher pairs them up immediately.
  return pairs.sort((a, b) => b.learner.persistenceScore - a.learner.persistenceScore);
}

/**
 * Assigns each misconception a stable colour index so the heatmap can colour
 * cells by error pattern (typology) rather than by score tier.
 */
export function buildMisconceptionColorIndex(
  clusters: MisconceptionCluster[],
): Map<string, number> {
  const index = new Map<string, number>();
  clusters.forEach((cluster, i) => index.set(cluster.misconceptionId, i));
  return index;
}
