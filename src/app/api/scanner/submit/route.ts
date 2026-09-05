import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";
import { updateStudentProgress, type Answer, type ConfidenceLevel } from "@/lib/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scanner/submit — paper-scan sessions have no auth uid (same
// problem as kiosk sessions), so scanned_answers inserts and student_progress
// upserts both go through the service-role client from this route instead of
// the browser client used directly by PaperScanner.tsx.
// ─────────────────────────────────────────────────────────────────────────────

interface ScannedAnswerInput {
  studentIdentifier: string;
  questionLabel: string;
  selectedOption: string | null;
  correctOption: string | null;
  isCorrect: boolean | null;
  topic: string;
}

interface PostBody {
  classId: string;
  answers: ScannedAnswerInput[];
}

function isValidBody(body: unknown): body is PostBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.classId !== "string" || !Array.isArray(b.answers)) return false;

  return b.answers.every((a) => {
    if (!a || typeof a !== "object") return false;
    const row = a as Record<string, unknown>;
    return (
      typeof row.studentIdentifier === "string" &&
      typeof row.questionLabel === "string" &&
      typeof row.topic === "string"
    );
  });
}

/**
 * Paper scans have no auth uid, so progress is keyed by a class-scoped name
 * slug — same convention as kiosk sessions, kept simple rather than trying to
 * fuzzy-match handwritten names against the class roster.
 */
function paperStudentId(classId: string, studentIdentifier: string): string {
  const slug = studentIdentifier.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `paper_${classId}_${slug}`;
}

const DEFAULT_CONFIDENCE: ConfidenceLevel = "unsure";

export async function POST(request: NextRequest) {
  const body: unknown = await request.json();

  if (!isValidBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { classId, answers } = body;
  let answersWritten = 0;

  try {
    await Promise.all(
      answers.map(async (row) => {
        const { error: insertError } = await supabaseAdmin.from("scanned_answers").insert({
          class_id: classId,
          student_identifier: row.studentIdentifier,
          question_label: row.questionLabel,
          selected_option: row.selectedOption,
          correct_option: row.correctOption,
          is_correct: row.isCorrect,
          topic: row.topic,
          source: "paper_scan",
        });

        if (insertError) {
          console.error("[api/scanner/submit] scanned_answers insert error", insertError);
        }

        if (row.selectedOption === null || row.isCorrect === null) return;

        const studentId = paperStudentId(classId, row.studentIdentifier);
        const answer: Answer = {
          studentUid: studentId,
          classId,
          topic: row.topic,
          isCorrect: row.isCorrect,
          isTransferQuestion: false,
          misconceptionId: null,
          confidenceLevel: DEFAULT_CONFIDENCE,
        };

        const answerId = `${studentId}_${classId}_${row.topic}_${row.questionLabel}_${Date.now()}`;

        await updateStudentProgress(
          supabaseAdmin,
          answerId,
          answer,
          row.isCorrect,
          null,
          DEFAULT_CONFIDENCE,
        );
        answersWritten += 1;
      }),
    );
  } catch (err) {
    console.error("[api/scanner/submit] error", err);
    return NextResponse.json({ error: "Failed to save scanned answers" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, answersWritten });
}
