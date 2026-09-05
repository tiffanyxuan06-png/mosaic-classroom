import { NextRequest, NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';

// ─────────────────────────────────────────────────────────────────────────────
// Student names for a class.
//
// `profiles` RLS only lets a user read their own row, so the teacher dashboard
// can't resolve student_uid → name with the anon client (which is why the
// heatmap and intervention groups used to render raw uuids). Rather than open
// up `profiles` to every class member, this route authorises the caller as
// that class's teacher and then reads the roster with the service role.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const classId = searchParams.get('classId');

  if (!classId) {
    return NextResponse.json({ error: 'classId query param is required' }, { status: 400 });
  }

  const accessToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!accessToken) {
    return NextResponse.json({ error: 'Missing bearer token' }, { status: 401 });
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const { data: classRow, error: classError } = await supabaseAdmin
    .from('classes')
    .select('teacher_id')
    .eq('id', classId)
    .maybeSingle();

  if (classError) {
    console.error('[api/class/roster] class lookup error', classError);
    return NextResponse.json({ error: 'Failed to load class' }, { status: 500 });
  }

  if (!classRow || classRow.teacher_id !== userData.user.id) {
    return NextResponse.json({ error: 'Not the teacher of this class' }, { status: 403 });
  }

  const { data: rosterData, error: rosterError } = await supabaseAdmin
    .from('profiles')
    .select('id, name')
    .eq('class_id', classId)
    .eq('role', 'student');

  if (rosterError) {
    console.error('[api/class/roster] roster lookup error', rosterError);
    return NextResponse.json({ error: 'Failed to load roster' }, { status: 500 });
  }

  return NextResponse.json({
    students: (rosterData ?? []).map((row) => ({
      id: row.id as string,
      name: (row.name as string) ?? '',
    })),
  });
}
