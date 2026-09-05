"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/lib/supabase-client";
import QuizQuestion, { type QuizQuestionData } from "@/components/QuizQuestion";
import FeedbackCard from "@/components/FeedbackCard";
import {
  applyAnswerLocally,
  getNextQuestionParams,
  type Answer,
  type ConfidenceLevel,
  type StudentProgress,
  type StudentTier,
} from "@/lib/helpers";
import { postWithOfflineFallback } from "@/lib/offlineQueue";
import { cacheMisconceptionCatalogue, classifyOffline } from "@/lib/offlineClassifier";
import ConnectionStatus from "@/components/ConnectionStatus";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_QUESTIONS_PER_SESSION = 3;
const COMPLETE_AUTO_ADVANCE_MS = 6000;

type Phase = "selection" | "quiz" | "complete" | "error";
type QuizStep = "question" | "feedback";

interface RosterStudent {
  id: string;
  name: string;
}

interface ClassInfo {
  id: string;
  subject: string;
  topics: string[];
}

interface AnswerState {
  isCorrect: boolean;
  misconceptionId: string | null;
  misconceptionLabel: string | null;
  misconceptionLabel_bm: string | null;
  confidenceLevel: ConfidenceLevel;
}

const TIER_COLORS: Record<StudentTier, string> = {
  red: "bg-red-500",
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  blue: "bg-blue-500",
};

/**
 * Kiosk sessions have no auth uid, so progress is keyed by a name+class slug
 * instead — scoped per class to avoid collisions between same-named students
 * in different classes. Progress for this synthetic id is only ever read or
 * written through the shared service-role /api/progress route (see that
 * route's header comment for why).
 */
function kioskStudentId(classId: string, studentName: string): string {
  const slug = studentName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `kiosk_${classId}_${slug}`;
}

function defaultProgress(studentUid: string, classId: string, topic: string): StudentProgress {
  return {
    studentUid,
    classId,
    topic,
    tier: "red",
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
    .from("misconceptions")
    .select("plain_language_label, plain_language_label_bm")
    .eq("id", misconceptionId)
    .maybeSingle();

  return {
    en: (data?.plain_language_label as string | undefined) ?? null,
    bm: (data?.plain_language_label_bm as string | undefined) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function KioskSessionPage({
  params,
}: {
  params: { classId: string };
}) {
  const { classId } = params;

  const [phase, setPhase] = useState<Phase>("selection");
  const [classInfo, setClassInfo] = useState<ClassInfo | null>(null);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);

  const [selectedStudent, setSelectedStudent] = useState<RosterStudent | null>(null);
  const [progress, setProgress] = useState<StudentProgress | null>(null);

  const [quizStep, setQuizStep] = useState<QuizStep>("question");
  const [question, setQuestion] = useState<QuizQuestionData | null>(null);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [answerState, setAnswerState] = useState<AnswerState | null>(null);
  const [questionsAnswered, setQuestionsAnswered] = useState(0);

  const consecutiveCorrectRef = useRef(0);
  const sessionHistoryRef = useRef<Answer[]>([]);

  const subject = classInfo?.subject ?? "mathematics";
  const topic = classInfo?.topics?.[0] ?? "fractions";

  // ── Load class + roster ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadClassAndRoster() {
      setRosterLoading(true);
      try {
        const res = await fetch(`/api/kiosk/session?classId=${encodeURIComponent(classId)}`);
        if (!res.ok) {
          if (!cancelled) setPhase("error");
          return;
        }

        const data: { classInfo: ClassInfo; roster: RosterStudent[] } = await res.json();

        if (!cancelled) {
          setClassInfo(data.classInfo);
          setRoster(data.roster);
        }
      } catch (err) {
        console.error("[kiosk] roster load error", err);
        if (!cancelled) setPhase("error");
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    }

    loadClassAndRoster();
    // Warm the offline catalogue while the kiosk still has a connection.
    void cacheMisconceptionCatalogue();
    return () => {
      cancelled = true;
    };
  }, [classId]);

  // ── Fetch next question ────────────────────────────────────────────────
  const fetchQuestion = useCallback(
    async (currentProgress: StudentProgress) => {
      setQuestionLoading(true);
      try {
        const nextParams = getNextQuestionParams(currentProgress, sessionHistoryRef.current);

        let activeMisconceptionDescription: string | null = null;
        if (nextParams.misconceptionId) {
          const labels = await fetchMisconceptionLabels(nextParams.misconceptionId);
          activeMisconceptionDescription = labels.en;
        }

        const res = await fetch("/api/quiz/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject,
            topic: currentProgress.topic,
            difficulty: nextParams.difficulty,
            activeMisconceptionId: nextParams.misconceptionId,
            activeMisconceptionDescription,
            previousQuestionTexts: [],
            isTransferQuestion: nextParams.isTransferQuestion,
            isResetQuestion: nextParams.isResetQuestion,
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: QuizQuestionData = await res.json();

        setQuestion(data);
      } catch (err) {
        console.error("[kiosk] fetchQuestion error", err);
        setPhase("error");
      } finally {
        setQuestionLoading(false);
      }
    },
    [subject],
  );

  // ── Select student → start quiz session ────────────────────────────────
  const handleSelectStudent = useCallback(
    async (student: RosterStudent) => {
      setSelectedStudent(student);
      consecutiveCorrectRef.current = 0;
      sessionHistoryRef.current = [];
      setQuestionsAnswered(0);
      setQuizStep("question");
      setAnswerState(null);

      const studentId = kioskStudentId(classId, student.name);

      try {
        const res = await fetch(
          `/api/progress?studentId=${encodeURIComponent(studentId)}&classId=${encodeURIComponent(
            classId,
          )}&topic=${encodeURIComponent(topic)}`,
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { progress: StudentProgress } = await res.json();
        const initialProgress = data.progress ?? defaultProgress(studentId, classId, topic);

        setProgress(initialProgress);
        setPhase("quiz");
        await fetchQuestion(initialProgress);
      } catch (err) {
        console.error("[kiosk] start session error", err);
        setPhase("error");
      }
    },
    [classId, topic, fetchQuestion],
  );

  // ── Classify misconception ──────────────────────────────────────────────
  const classifyMisconception = useCallback(
    async (q: QuizQuestionData, selectedOption: string, currentProgress: StudentProgress) => {
      try {
        const res = await fetch("/api/quiz/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            questionText: q.questionText,
            correctAnswer: q.options[q.correctOption as keyof typeof q.options],
            studentAnswer: q.options[selectedOption as keyof typeof q.options],
            subject,
            topic: currentProgress.topic,
          }),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const labels = await fetchMisconceptionLabels(data.misconceptionId as string);

        return {
          misconceptionId: data.misconceptionId as string,
          label: labels.en ?? (data.reasoning as string),
          label_bm: labels.bm ?? (data.reasoning as string),
        };
      } catch {
        // Offline: match locally against the cached catalogue.
        const local = classifyOffline({
          subject,
          topic: currentProgress.topic,
          questionText: q.questionText,
          studentAnswer: q.options[selectedOption as keyof typeof q.options],
        });

        if (local) {
          const labels = await fetchMisconceptionLabels(local.misconceptionId).catch(
            () => ({ en: null, bm: null }),
          );
          return {
            misconceptionId: local.misconceptionId,
            label: labels.en ?? local.reasoning,
            label_bm: labels.bm ?? local.reasoning,
          };
        }

        const active = currentProgress.activeMisconceptions.find((m) => !m.isCleared);
        return {
          misconceptionId: active?.misconceptionId ?? "unknown",
          label: "Review this concept carefully.",
          label_bm: "Semak konsep ini dengan teliti.",
        };
      }
    },
    [subject],
  );

  // ── Submit answer ────────────────────────────────────────────────────────
  const handleQuestionSubmit = useCallback(
    async (
      selectedOption: string,
      confidenceLevel: ConfidenceLevel,
      timeSpentMs: number,
      answerChanges: number,
    ) => {
      if (!question || !progress || !selectedStudent) return;

      const isCorrect = selectedOption === question.correctOption;
      const isTransferQuestion = question.isTransferQuestion;

      if (isCorrect) {
        consecutiveCorrectRef.current += 1;
      } else {
        consecutiveCorrectRef.current = 0;
      }

      let misconceptionId: string | null = null;
      let misconceptionLabel: string | null = null;
      let misconceptionLabel_bm: string | null = null;

      if (!isCorrect) {
        const classified = await classifyMisconception(question, selectedOption, progress);
        misconceptionId = classified.misconceptionId;
        misconceptionLabel = classified.label;
        misconceptionLabel_bm = classified.label_bm;
      }

      setAnswerState({
        isCorrect,
        misconceptionId,
        misconceptionLabel,
        misconceptionLabel_bm,
        confidenceLevel,
      });

      const studentId = kioskStudentId(classId, selectedStudent.name);

      sessionHistoryRef.current = [
        ...sessionHistoryRef.current,
        {
          studentUid: studentId,
          classId,
          topic: progress.topic,
          isCorrect,
          isTransferQuestion,
          misconceptionId,
          confidenceLevel,
        },
      ];

      // Raw kiosk answer log — separate from the progress row. Queued offline
      // so a wifi drop mid-session doesn't lose the evidence trail.
      try {
        await postWithOfflineFallback("/api/kiosk/answer", {
          classId,
          studentName: selectedStudent.name,
          questionId: question.questionId,
          questionText: question.questionText,
          selectedOption,
          correctOption: question.correctOption,
          isCorrect,
          confidenceLevel,
          timeSpentMs,
          answerChanges,
          misconceptionId,
          topic: progress.topic,
        });
      } catch (err) {
        console.error("[kiosk] answer log error", err);
      }

      try {
        const res = await postWithOfflineFallback("/api/progress", {
          studentId,
          classId,
          topic: progress.topic,
          isCorrect,
          isTransferQuestion,
          misconceptionId,
          confidenceLevel,
        });

        if (res?.ok) {
          const data: { progress: StudentProgress } = await res.json();
          setProgress(data.progress);
        } else {
          // Offline: advance the tier locally so the kiosk keeps working.
          setProgress((prev) =>
            applyAnswerLocally(prev ?? defaultProgress(studentId, classId, progress.topic), {
              isCorrect,
              misconceptionId,
            }),
          );
        }
      } catch (err) {
        console.error("[kiosk] updateStudentProgress error", err);
      }

      setQuizStep("feedback");
    },
    [question, progress, selectedStudent, classId, classifyMisconception],
  );

  // ── After feedback: next question or finish session ─────────────────────
  const handleFeedbackNext = useCallback(async () => {
    const nextCount = questionsAnswered + 1;
    setQuestionsAnswered(nextCount);

    if (nextCount >= MAX_QUESTIONS_PER_SESSION) {
      setPhase("complete");
      return;
    }

    setQuizStep("question");
    setAnswerState(null);
    if (progress) {
      await fetchQuestion(progress);
    }
  }, [questionsAnswered, progress, fetchQuestion]);

  // ── Reset back to student selection ──────────────────────────────────────
  const resetToSelection = useCallback(() => {
    setPhase("selection");
    setSelectedStudent(null);
    setProgress(null);
    setQuestion(null);
    setAnswerState(null);
    setQuestionsAnswered(0);
  }, []);

  // ── Auto-advance from the complete screen ────────────────────────────────
  useEffect(() => {
    if (phase !== "complete") return;
    const timer = setTimeout(resetToSelection, COMPLETE_AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [phase, resetToSelection]);

  // ── Render: selection ─────────────────────────────────────────────────────
  if (phase === "selection") {
    return (
      <div className="min-h-screen bg-muted/40 p-6">
        <ConnectionStatus />
        <h1 className="mb-8 text-center text-5xl font-bold">Who are you?</h1>

        {rosterLoading ? (
          <p className="text-center text-xl text-muted-foreground">Loading class...</p>
        ) : roster.length === 0 ? (
          <p className="text-center text-xl text-muted-foreground">
            No students found for this class yet.
          </p>
        ) : (
          <div className="mx-auto grid max-w-4xl grid-cols-3 gap-4">
            {roster.map((student) => (
              <button
                key={student.id}
                type="button"
                onClick={() => handleSelectStudent(student)}
                className="min-h-[80px] rounded-xl border-2 border-input bg-background px-4 py-4 text-xl font-semibold shadow-sm transition-colors hover:border-primary hover:bg-accent active:scale-[0.98]"
              >
                {student.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Render: quiz ────────────────────────────────────────────────────────
  if (phase === "quiz") {
    return (
      <div className="min-h-screen bg-muted/40 p-6">
        <ConnectionStatus />
        <div className="mx-auto max-w-2xl space-y-4">
          <p className="text-center text-lg font-medium text-muted-foreground">
            {selectedStudent?.name} — Question{" "}
            {Math.min(questionsAnswered + 1, MAX_QUESTIONS_PER_SESSION)} of{" "}
            {MAX_QUESTIONS_PER_SESSION}
          </p>

          {quizStep === "question" ? (
            question || questionLoading ? (
              <QuizQuestion
                question={
                  question ?? {
                    questionId: "loading",
                    questionText: "",
                    options: { A: "", B: "", C: "", D: "" },
                    correctOption: "A",
                    isTransferQuestion: false,
                    isResetQuestion: false,
                  }
                }
                onSubmit={handleQuestionSubmit}
                language="en"
                isLoading={questionLoading}
              />
            ) : null
          ) : (
            answerState &&
            question && (
              <FeedbackCard
                isCorrect={answerState.isCorrect}
                misconceptionId={answerState.misconceptionId}
                misconceptionLabel={answerState.misconceptionLabel}
                misconceptionLabel_bm={answerState.misconceptionLabel_bm}
                isTransferQuestion={question.isTransferQuestion}
                isResetQuestion={question.isResetQuestion}
                confidenceLevel={answerState.confidenceLevel}
                language="en"
                onNext={handleFeedbackNext}
              />
            )
          )}
        </div>
      </div>
    );
  }

  // ── Render: complete ────────────────────────────────────────────────────
  if (phase === "complete") {
    const tier: StudentTier = progress?.tier ?? "red";

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/40 p-6 text-center">
        <div className={`h-24 w-24 rounded-full ${TIER_COLORS[tier]}`} />
        <h1 className="text-4xl font-bold">Well done, {selectedStudent?.name}!</h1>
        <p className="text-xl text-muted-foreground">
          Pass the tablet to the next student.
        </p>
        <button
          type="button"
          onClick={resetToSelection}
          className="mt-4 rounded-xl bg-primary px-8 py-4 text-lg font-semibold text-primary-foreground shadow-md transition-colors hover:bg-primary/90"
        >
          Done →
        </button>
      </div>
    );
  }

  // ── Render: error ───────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/40 p-6 text-center">
      <h1 className="text-3xl font-bold">Something went wrong.</h1>
      <p className="text-xl text-muted-foreground">Ask your teacher for help.</p>
    </div>
  );
}
