import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin, requireSupabaseAdmin } from "@/lib/supabase-admin";

// ─────────────────────────────────────────────────────────────────────────────
// Pulse responses are written from the student page, which (in its current
// demo form) has no real Supabase Auth session backing STUDENT_ID. RLS on
// pulse_responses requires `student_id = auth.uid()::text`, which an anon
// client can never satisfy here, so this write goes through the service role.
// ─────────────────────────────────────────────────────────────────────────────

interface PulseAnswer {
  questionIndex: number;
  selectedOption: string;
}

interface PostBody {
  pulseId: string;
  studentId: string;
  classId: string;
  answers: PulseAnswer[];
}

function isValidBody(body: unknown): body is PostBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.pulseId === "string" &&
    typeof b.studentId === "string" &&
    typeof b.classId === "string" &&
    Array.isArray(b.answers)
  );
}

export async function POST(request: NextRequest) {
  const notConfigured = requireSupabaseAdmin();
  if (notConfigured) return notConfigured;

  const body: unknown = await request.json();

  if (!isValidBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { pulseId, studentId, classId, answers } = body;

  const { error } = await supabaseAdmin.from("pulse_responses").upsert({
    id: `${pulseId}_${studentId}`,
    pulse_id: pulseId,
    student_id: studentId,
    class_id: classId,
    answers,
    completed_at: new Date().toISOString(),
  });

  if (error) {
    console.error("[api/pulse/respond] POST error", error);
    return NextResponse.json({ error: "Failed to save pulse response" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
