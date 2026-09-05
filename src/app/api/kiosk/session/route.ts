import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin, requireSupabaseAdmin } from "@/lib/supabase-admin";

// ─────────────────────────────────────────────────────────────────────────────
// A kiosk tablet has no Supabase Auth session, so anon-client reads of
// `classes` (RLS-gated to class members via `profiles`) and `profiles`
// (which also carries student emails) would always come back empty or leak
// more than a kiosk should see. This route returns only the minimal roster
// fields (id, name) needed to render the "Who are you?" screen.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const notConfigured = requireSupabaseAdmin();
  if (notConfigured) return notConfigured;

  const { searchParams } = new URL(request.url);
  const classId = searchParams.get("classId");

  if (!classId) {
    return NextResponse.json({ error: "classId query param is required" }, { status: 400 });
  }

  const { data: classData, error: classError } = await supabaseAdmin
    .from("classes")
    .select("id, subject, topics")
    .eq("id", classId)
    .maybeSingle();

  if (classError) {
    console.error("[api/kiosk/session] class lookup error", classError);
    return NextResponse.json({ error: "Failed to load class" }, { status: 500 });
  }

  if (!classData) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }

  const { data: rosterData, error: rosterError } = await supabaseAdmin
    .from("profiles")
    .select("id, name")
    .eq("class_id", classId)
    .eq("role", "student");

  if (rosterError) {
    console.error("[api/kiosk/session] roster lookup error", rosterError);
    return NextResponse.json({ error: "Failed to load roster" }, { status: 500 });
  }

  const roster = (rosterData ?? [])
    .map((row) => ({ id: row.id as string, name: (row.name as string) ?? "" }))
    .filter((s) => s.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    classInfo: {
      id: classData.id as string,
      subject: (classData.subject as string) ?? "mathematics",
      topics: (classData.topics as string[] | null) ?? [],
    },
    roster,
  });
}
