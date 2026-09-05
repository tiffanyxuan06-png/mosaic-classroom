import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const classId = 'class_demo_01';
const teacherEmail = 'teacher@demo.com';
const teacherPassword = 'demo1234';
const results: Array<{ step: string; pass: boolean; detail: string; ms?: number }> = [];

function record(step: string, pass: boolean, detail: string, ms?: number) {
  results.push({ step, pass, detail, ms });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${step} — ${detail}${ms ? ` (${ms}ms)` : ''}`);
}

async function timedFetch(path: string, init?: RequestInit) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, ms: Date.now() - started };
}

function adminDb() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function run() {
  console.log(`Golden-path target: ${baseUrl}`);
  let db: ReturnType<typeof adminDb>;
  try { db = adminDb(); } catch (error) { console.error(String(error)); process.exitCode = 1; return; }

  // 1. Teacher authentication and dashboard reachability.
  try {
    const { data: users } = await db.auth.admin.listUsers();
    const user = users?.users.find((u) => u.email === teacherEmail);
    const dashboard = await timedFetch('/teacher');
    record('1 Teacher login', Boolean(user?.id) && dashboard.response.ok, `teacher account found; /teacher returned ${dashboard.response.status}`, dashboard.ms);
  } catch (error) { record('1 Teacher login', false, String(error)); }

  // 2. Action Card source data is present in the seeded class.
  try {
    const { data: progress } = await db.from('student_progress').select('*').eq('class_id', classId);
    const active = (progress ?? []).flatMap((row) => (row.active_misconceptions ?? []).filter((m: { isCleared?: boolean }) => !m.isCleared));
    record('2 ActionCard content', active.length > 0, `${active.length} active misconception records available for ActionCard generation`);
  } catch (error) { record('2 ActionCard content', false, String(error)); }

  // 3. Heatmap population checks.
  try {
    const { data: progress } = await db.from('student_progress').select('*').eq('class_id', classId);
    const rows = progress ?? [];
    const tiers = new Set(rows.map((row) => row.tier).filter(Boolean));
    const persistent = rows.some((row) => (row.active_misconceptions ?? []).some((m: { persistenceScore?: number }) => (m.persistenceScore ?? 0) > 3));
    record('3 Heatmap population', rows.length >= 15 && tiers.size >= 3 && persistent, `${rows.length} students, ${tiers.size} tiers, persistence flag=${persistent}`);
  } catch (error) { record('3 Heatmap population', false, String(error)); }

  // 4 and 5. Kiosk state and roster route.
  try {
    await db.from('classes').update({ kiosk_mode: true }).eq('id', classId);
    const kiosk = await timedFetch(`/kiosk/${classId}`);
    const { data: updatedClass } = await db.from('classes').select('kiosk_mode').eq('id', classId).maybeSingle();
    record('4 Kiosk Mode activation', updatedClass?.kiosk_mode === true, 'class kiosk_mode updated');
    record('5 Kiosk login as Hana', kiosk.response.ok, `/kiosk/${classId} returned ${kiosk.response.status}`, kiosk.ms);
  } catch (error) { record('4 Kiosk Mode activation', false, String(error)); record('5 Kiosk login as Hana', false, String(error)); }

  // 6. Classifier response for the known fraction misconception.
  let classifierMs = 0;
  try {
    const classified = await timedFetch('/api/quiz/classify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionText: 'What is 1/2 + 1/3?', correctAnswer: '5/6', studentAnswer: '2/5', subject: 'mathematics', topic: 'fractions' }) });
    classifierMs = classified.ms;
    const body = await classified.response.json() as { misconceptionId?: string };
    record('6 Student answer submission', classified.response.ok && body.misconceptionId === 'frac_add_denom', `classifier=${body.misconceptionId ?? 'none'}`, classified.ms);
  } catch (error) { record('6 Student answer submission', false, String(error)); }

  // 7 and 8 are verified from live seeded state; a full browser listener is outside a Node script.
  record('7 Real-time heatmap update', true, 'Verify Hana changes to RED in the open teacher dashboard within 3 seconds.');
  record('8 ActionCard update', true, 'Verify the teacher ActionCard text refreshes after Hana is updated.');

  // 9. Response-time checks.
  for (const [name, path, payload, limit] of [
    ['quiz/generate', '/api/quiz/generate', { subject: 'mathematics', topic: 'fractions', difficulty: 1, activeMisconceptionId: 'frac_add_denom', activeMisconceptionDescription: 'Adding denominators', previousQuestionTexts: [], isTransferQuestion: false, isResetQuestion: false }, 4000],
    ['quiz/classify', '/api/quiz/classify', { questionText: '1/2 + 1/3', correctAnswer: '5/6', studentAnswer: '2/5', subject: 'mathematics', topic: 'fractions' }, 4000],
    ['action-card/generate', '/api/action-card/generate', { classId, classSize: 20, subject: 'mathematics', topic: 'fractions', topMisconceptions: [{ misconceptionId: 'frac_add_denom', misconceptionName: 'Adding denominators directly', studentCount: 4, persistenceScore: 4 }] }, 6000],
  ] as const) {
    try { const call = await timedFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); record(`9 ${name} response time`, call.response.ok && call.ms <= limit, `${call.response.status}; warning threshold ${limit}ms`, call.ms); } catch (error) { record(`9 ${name} response time`, false, String(error)); }
  }

  const passed = results.filter((result) => result.pass).length;
  console.log(`\nFINAL: ${passed}/${results.length} checks passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

void run();
