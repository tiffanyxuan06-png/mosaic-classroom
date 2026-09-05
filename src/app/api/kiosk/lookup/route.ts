import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/supabase-admin";

// ─────────────────────────────────────────────────────────────────────────────
// Resolving a kiosk code to a class happens before anyone is signed in, so an
// anon-client read against `classes` (RLS-gated to class members) would
// always come back empty. This uses the service role instead.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "code query param is required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("classes")
    .select("id")
    .eq("kiosk_code", code)
    .maybeSingle();

  if (error) {
    console.error("[api/kiosk/lookup] GET error", error);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "No class found with that code" }, { status: 404 });
  }

  return NextResponse.json({ classId: data.id as string });
}
