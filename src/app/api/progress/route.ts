import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  updateStudentProgress,
  type ActiveMisconception,
  type Answer,
  type ConfidenceLevel,
  type StudentProgress,
  type StudentTier,
} from "@/lib/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared progress endpoint for every flow that doesn't have a real Supabase
// Auth session backing its student id: kiosk sessions (tablet-selected name,
// no auth.users row), the paper-scanner flow, and the current demo student
// page (hardcoded STUDENT_ID, not wired to real login yet). RLS policies keyed
// on `student_uid = auth.uid()` can never match any of these, so every
// read/write of their progress goes through this service-role API route
// instead of the anon browser client.
// ─────────────────────────────────────────────────────────────────────────────

function defaultProgress(
  studentUid: string,
  classId: string,
  topic: string,
): StudentProgress {
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

function rowToProgress(row: Record<string, unknown>): StudentProgress {
  return {
    studentUid: row.student_uid as string,
    classId: row.class_id as string,
    topic: row.topic as string,
    tier: row.tier as StudentTier,
    activeMisconceptions: Array.isArray(row.active_misconceptions)
      ? (row.active_misconceptions as ActiveMisconception[])
      : [],
    masteryScore: row.mastery_score as number,
    consecutiveCorrect: row.consecutive_correct as number,
    transferPassed: row.transfer_passed as boolean,
    sessionsActive: (row.sessions_active as number | undefined) ?? 1,
  };
}

async function loadProgress(
  studentId: string,
  classId: string,
  topic: string,
): Promise<{ progress: StudentProgress | null; error: unknown }> {
  const { data, error } = await supabaseAdmin
    .from("student_progress")
    .select("*")
    .eq("student_uid", studentId)
    .eq("class_id", classId)
    .eq("topic", topic)
    .maybeSingle();

  if (error) return { progress: null, error };
  return { progress: data ? rowToProgress(data) : null, error: null };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/progress?studentId=&classId=&topic=
// ────────────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const studentId = searchParams.get("studentId");
  const classId = searchParams.get("classId");
  const topic = searchParams.get("topic");

  if (!studentId || !classId || !topic) {
    return NextResponse.json(
      { error: "studentId, classId, and topic query params are required" },
      { status: 400 },
    );
  }

  const { progress, error } = await loadProgress(studentId, classId, topic);

  if (error) {
    console.error("[api/progress] GET error", error);
    return NextResponse.json({ error: "Failed to load progress" }, { status: 500 });
  }

  return NextResponse.json({
    progress: progress ?? defaultProgress(studentId, classId, topic),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/progress
// Body: { studentId, classId, topic, isCorrect, isTransferQuestion?,
//         misconceptionId, confidenceLevel }
// ────────────────────────────────────────────────────────────────────────────

interface PostBody {
  studentId: string;
  classId: string;
  topic: string;
  isCorrect: boolean;
  isTransferQuestion?: boolean;
  misconceptionId: string | null;
  confidenceLevel: ConfidenceLevel;
}

function isValidBody(body: unknown): body is PostBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.studentId === "string" &&
    typeof b.classId === "string" &&
    typeof b.topic === "string" &&
    typeof b.isCorrect === "boolean" &&
    (b.misconceptionId === null || typeof b.misconceptionId === "string") &&
    ["guessed", "unsure", "knew"].includes(b.confidenceLevel as string)
  );
}

export async function POST(request: NextRequest) {
  const body: unknown = await request.json();

  if (!isValidBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { studentId, classId, topic, isCorrect, isTransferQuestion, misconceptionId, confidenceLevel } =
    body;

  const answer: Answer = {
    studentUid: studentId,
    classId,
    topic,
    isCorrect,
    isTransferQuestion: Boolean(isTransferQuestion),
    misconceptionId,
    confidenceLevel,
  };

  const answerId = `${studentId}_${classId}_${topic}_${Date.now()}`;

  try {
    await updateStudentProgress(
      supabaseAdmin,
      answerId,
      answer,
      isCorrect,
      misconceptionId,
      confidenceLevel,
    );
  } catch (err) {
    console.error("[api/progress] POST error", err);
    return NextResponse.json({ error: "Failed to update progress" }, { status: 500 });
  }

  const { progress, error } = await loadProgress(studentId, classId, topic);

  if (error || !progress) {
    console.error("[api/progress] refetch error", error);
    return NextResponse.json({ error: "Failed to load updated progress" }, { status: 500 });
  }

  return NextResponse.json({ progress });
}
