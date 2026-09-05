-- Mosaic Classroom Postgres schema (Supabase)
-- Run this once against a fresh Supabase project's SQL editor (or via the
-- Supabase CLI) before running `npm run seed`.

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- profiles (replaces Firestore "users" collection)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text,
  role text not null check (role in ('teacher', 'student')),
  class_id text,
  class_name text,
  language text default 'en',
  kiosk_only boolean not null default false,
  created_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- classes
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists classes (
  id text primary key,
  teacher_id uuid references profiles (id),
  name text not null,
  subject text not null,
  topics text[] not null default '{}',
  kiosk_mode boolean not null default false,
  kiosk_code text unique,
  student_count int not null default 0,
  created_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- misconceptions (catalogue, seeded from src/data/misconceptions.json)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists misconceptions (
  id text primary key,
  subject text not null,
  topic text not null,
  name text not null,
  name_bm text,
  wrong_answer_pattern text,
  plain_language_label text,
  plain_language_label_bm text,
  remediation_approach text,
  prerequisite_misconception_id text references misconceptions (id),
  severity text not null check (severity in ('foundational', 'procedural', 'conceptual')),
  updated_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- student_progress (canonical schema: one row per student per topic,
-- matching src/lib/helpers.ts's StudentProgress shape)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists student_progress (
  id uuid primary key default gen_random_uuid(),
  -- text, not uuid: holds real auth.users uuids (as text) for authenticated
  -- students AND synthetic string ids (e.g. "kiosk_{classId}_{slug}",
  -- "paper_{classId}_{slug}") for kiosk/paper-scan sessions that never
  -- authenticate with Supabase Auth.
  student_uid text not null,
  class_id text not null,
  topic text not null,
  tier text not null default 'green' check (tier in ('red', 'yellow', 'green', 'blue')),
  active_misconceptions jsonb not null default '[]'::jsonb,
  mastery_score int not null default 0,
  consecutive_correct int not null default 0,
  transfer_passed boolean not null default false,
  sessions_active int not null default 1,
  last_updated timestamptz not null default now(),
  unique (student_uid, class_id, topic)
);

create index if not exists student_progress_class_id_idx on student_progress (class_id);
create index if not exists student_progress_student_uid_idx on student_progress (student_uid);

-- ────────────────────────────────────────────────────────────────────────────
-- answers (append-only log)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists answers (
  id text primary key default gen_random_uuid()::text,
  -- text for the same reason as student_progress.student_uid above.
  student_uid text not null,
  class_id text not null,
  topic text not null,
  is_correct boolean not null,
  is_transfer_question boolean not null default false,
  misconception_id text,
  confidence_level text not null check (confidence_level in ('guessed', 'unsure', 'knew')),
  "timestamp" timestamptz not null default now()
);

create index if not exists answers_student_uid_idx on answers (student_uid);

-- ────────────────────────────────────────────────────────────────────────────
-- pulses / pulse_responses
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists pulses (
  id text primary key,
  class_id text not null,
  teacher_uid uuid,
  questions jsonb not null default '[]'::jsonb,
  target_misconception jsonb,
  status text not null default 'active' check (status in ('active', 'completed', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists pulses_class_id_idx on pulses (class_id);

create table if not exists pulse_responses (
  id text primary key,
  pulse_id text not null references pulses (id),
  student_id text not null,
  class_id text not null,
  answers jsonb not null default '[]'::jsonb,
  completed_at timestamptz not null default now()
);

create index if not exists pulse_responses_pulse_id_idx on pulse_responses (pulse_id);

-- ────────────────────────────────────────────────────────────────────────────
-- kiosk_answers / scanned_answers (written only via the service-role API
-- routes — these flows never authenticate as a real Supabase user)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists kiosk_answers (
  id uuid primary key default gen_random_uuid(),
  class_id text not null,
  student_name text not null,
  is_kiosk_session boolean not null default true,
  question_id text,
  question_text text,
  selected_option text,
  correct_option text,
  is_correct boolean,
  confidence_level text,
  time_spent_ms int,
  answer_changes int,
  misconception_id text,
  topic text,
  created_at timestamptz not null default now()
);

create table if not exists scanned_answers (
  id uuid primary key default gen_random_uuid(),
  class_id text not null,
  student_identifier text not null,
  question_label text,
  selected_option text,
  correct_option text,
  is_correct boolean,
  topic text,
  source text not null default 'paper_scan',
  scanned_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ────────────────────────────────────────────────────────────────────────────
alter table profiles enable row level security;
alter table classes enable row level security;
alter table misconceptions enable row level security;
alter table student_progress enable row level security;
alter table answers enable row level security;
alter table pulses enable row level security;
alter table pulse_responses enable row level security;
alter table kiosk_answers enable row level security;
alter table scanned_answers enable row level security;

-- profiles: a user can read their own profile
create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);

-- profiles: a teacher can read every profile in a class they teach.
-- The helper is security definer so this policy does not recurse through
-- classes_select_member (which itself reads profiles).
create or replace function public.is_teacher_of_class(target_class_id text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from classes
    where classes.id = target_class_id
      and classes.teacher_id = auth.uid()
  );
$$;

revoke all on function public.is_teacher_of_class(text) from public;
grant execute on function public.is_teacher_of_class(text) to authenticated;

create policy "profiles_select_class_teacher" on profiles
  for select using (
    class_id is not null and public.is_teacher_of_class(class_id)
  );

-- classes: any authenticated user in that class (student or teacher) can read it
create policy "classes_select_member" on classes
  for select using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.class_id = classes.id
    )
  );

create policy "classes_update_teacher" on classes
  for update using (teacher_id = auth.uid());

-- misconceptions: curriculum reference data, no PII — publicly readable so
-- that unauthenticated flows (kiosk, the demo student page) can resolve
-- misconception labels without a Supabase Auth session.
create policy "misconceptions_select_all" on misconceptions
  for select using (true);

-- student_progress: readable by the student themself or the teacher of that class
create policy "student_progress_select_own_or_teacher" on student_progress
  for select using (
    student_uid = auth.uid()::text
    or exists (
      select 1 from classes
      where classes.id = student_progress.class_id and classes.teacher_id = auth.uid()
    )
  );

create policy "student_progress_upsert_own" on student_progress
  for insert with check (student_uid = auth.uid()::text);

create policy "student_progress_update_own" on student_progress
  for update using (student_uid = auth.uid()::text);

-- answers: student can insert/read their own; teacher can read their class's
create policy "answers_select_own_or_teacher" on answers
  for select using (
    student_uid = auth.uid()::text
    or exists (
      select 1 from classes
      where classes.id = answers.class_id and classes.teacher_id = auth.uid()
    )
  );

create policy "answers_insert_own" on answers
  for insert with check (student_uid = auth.uid()::text);

-- pulses: quiz question content, no PII — publicly readable so the demo
-- student page's realtime pulse-detection subscription can receive events
-- without a real Supabase Auth session.
create policy "pulses_select_public" on pulses
  for select using (true);

-- pulse_responses: student can insert/read their own; teacher can read their class's
create policy "pulse_responses_select_own_or_teacher" on pulse_responses
  for select using (
    student_id = auth.uid()::text
    or exists (
      select 1 from classes
      where classes.id = pulse_responses.class_id and classes.teacher_id = auth.uid()
    )
  );

create policy "pulse_responses_insert_own" on pulse_responses
  for insert with check (student_id = auth.uid()::text);

-- kiosk_answers / scanned_answers: no client-side policies — these tables are
-- written and read only via the service-role key from API routes.

-- ────────────────────────────────────────────────────────────────────────────
-- Realtime publication
-- ────────────────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table classes;
alter publication supabase_realtime add table student_progress;
alter publication supabase_realtime add table pulses;
alter publication supabase_realtime add table pulse_responses;
