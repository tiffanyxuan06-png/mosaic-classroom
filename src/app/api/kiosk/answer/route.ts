import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin, requireSupabaseAdmin } from "@/lib/supabase-admin";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/kiosk/answer — raw kiosk answer log, separate from the progress
// document. Written only via the service-role client: kiosk_answers has no
// client-side RLS policies (see supabase/schema.sql).
// ─────────────────────────────────────────────────────────────────────────────

interface PostBody {
  classId: string;
  studentName: string;
  questionId?: string | null;
  questionText?: string | null;
  selectedOption?: string | null;
  correctOption?: string | null;
  isCorrect?: boolean | null;
  confidenceLevel?: string | null;
  timeSpentMs?: number | null;
  answerChanges?: number | null;
  misconceptionId?: string | null;
  topic?: string | null;
}

function isValidBody(body: unknown): body is PostBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.classId === "string" && typeof b.studentName === "string";
}

export async function POST(request: NextRequest) {
  const notConfigured = requireSupabaseAdmin();
  if (notConfigured) return notConfigured;

  const body: unknown = await request.json();

  if (!isValidBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from("kiosk_answers").insert({
    class_id: body.classId,
    student_name: body.studentName,
    is_kiosk_session: true,
    question_id: body.questionId ?? null,
    question_text: body.questionText ?? null,
    selected_option: body.selectedOption ?? null,
    correct_option: body.correctOption ?? null,
    is_correct: body.isCorrect ?? null,
    confidence_level: body.confidenceLevel ?? null,
    time_spent_ms: body.timeSpentMs ?? null,
    answer_changes: body.answerChanges ?? null,
    misconception_id: body.misconceptionId ?? null,
    topic: body.topic ?? null,
  });

  if (error) {
    console.error("[api/kiosk/answer] insert error", error);
    return NextResponse.json({ error: "Failed to log kiosk answer" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
