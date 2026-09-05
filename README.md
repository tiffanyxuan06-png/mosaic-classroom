# Mosaic Classroom

An AI-assisted classroom tool for Form 2 Mathematics that turns wrong answers
into a live map of *why* students are getting things wrong, not just that
they are. Students work through adaptive quizzes; Gemini classifies each
mistake against a catalogue of known misconceptions; teachers see a
real-time heatmap of the class, get a one-click "what to do next" action
card, and can generate targeted practice slips for the students who need
them. A kiosk mode and a paper-answer-sheet scanner support classrooms
without one device per student.

Built with Next.js 14 (App Router), TypeScript, Firebase (Auth + Firestore),
and the Gemini API via `@ai-sdk/google`.

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up Firebase

You need a Firebase project with **Firestore** and **Authentication**
(Email/Password provider) enabled.

1. Create a project at the [Firebase Console](https://console.firebase.google.com/).
2. **Build -> Firestore Database** -> create a database (test mode is fine for local dev).
3. **Build -> Authentication** -> Get started -> **Sign-in method** tab -> enable **Email/Password**.
   Skipping this step is the most common cause of a
   `Firebase: Error (auth/configuration-not-found)` error on sign-in.
4. **Project settings -> General -> Your apps** -> add a Web app (or open an
   existing one) to get the `firebaseConfig` values for step 3 below.
5. **Project settings -> Service accounts** -> Generate new private key, to get
   the Admin SDK credentials the seed script needs (step 4 below).

### 3. Configure environment variables

Copy the example file and fill it in:

```bash
cp .env.local.example .env.local
```

`.env.local` is gitignored, never commit it.

| Variable | Where it's used | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_*` (6 vars) | Browser - Auth + Firestore client SDK | Firebase Console -> Project settings -> General -> Your apps |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Server - Admin SDK (API routes, `npm run seed`) | Firebase Console -> Project settings -> Service accounts -> Generate new private key |
| `GEMINI_API_KEY` | Server - misconception classification, quiz/action-card/scanner generation | [Google AI Studio](https://aistudio.google.com/apikey) |

The `NEXT_PUBLIC_*` values are safe to expose to the browser (that is what
`NEXT_PUBLIC_` means to Next.js) - Firebase security comes from Firestore/Auth
rules, not from keeping these secret. The Admin SDK and Gemini keys are real
secrets and must never end up in client code or a committed file.

Alternatively, `GOOGLE_APPLICATION_CREDENTIALS` can point at a downloaded
service-account JSON file instead of the three `FIREBASE_*` variables.

### 4. Seed demo data (optional but recommended)

```bash
npm run seed               # writes to the Firebase project in .env.local
npm run seed -- --dry-run  # preview without writing anything
```

This creates one demo class ("Form 2 Mathematics", kiosk code `MATH01`), a
teacher account, and 20 students spread across the four mastery tiers with
realistic misconception histories, plus two "golden path" students (`Hana`,
`Adam`) pre-configured to demonstrate the misconception-detection and
peer-explainer flows, and a kiosk-only student (`Priya`) for the kiosk demo.
See [scripts/seedFirestore.ts](scripts/seedFirestore.ts) for the full roster
and the exact credentials it prints at the end of a run, by default:

- Teacher: `teacher@demo.com` / `demo1234`
- Students: `demo1234` (see the script's printed summary for each email)

It is safe to re-run, every document uses a deterministic ID and the RNG is
seeded, so a second run reproduces the same demo state rather than
duplicating it.

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign in at `/` with a
teacher or student account (from the seed script, or one you create in the
Firebase Console) - it routes to `/teacher` or `/student` based on the
signed-in user's role. `/kiosk` doesn't require sign-in; enter the class's
kiosk code to join.

## Project structure

```
src/
  app/
    page.tsx                    Sign-in page -> routes to /teacher or /student
    teacher/                    Teacher dashboard (ActionCard, ClassGapMap heatmap,
                                 intervention groups, kiosk activity feed, student panel)
    student/                    Student quiz flow (adaptive questions, feedback, mastery map)
    kiosk/                      Shared-device mode: join by class code, pick a name, answer
    api/
      quiz/generate/            Generates the next adaptive question for a student
      quiz/classify/            Classifies a wrong answer against the misconception catalogue
      action-card/generate/     Generates the teacher's "what to do next" recommendation
      capsule/generate/         Generates a downloadable HTML practice capsule/slip
      pulse/create/             Generates a quick "pulse check" question set for a class
      scanner/scan/             Reads a photographed paper answer sheet via Gemini Vision
  components/
    ActionCard.tsx              Full-width teacher recommendation card
    ClassGapMap.tsx             Class heatmap grid + student detail sheet
    QuizQuestion.tsx / FeedbackCard.tsx   Student quiz UI
    PaperScanner.tsx            Paper answer-sheet scanning UI + printable slip generator
  lib/
    firebase.ts                 Firebase Admin SDK (server-only)
    firebase-client.ts          Firebase client SDK singleton
    auth.ts                     Sign-in/out + useUserRole() hook
    gemini.ts                   Gemini client + JSON-response helpers
    helpers.ts                  Core tier/persistence logic (calculateTier,
                                 calculatePersistenceScore) - the source of truth
                                 the teacher dashboard and the seed script both use
    studentProgress.ts          Student-facing progress helpers used by the kiosk flow
  data/
    misconceptions.json         Canonical misconception catalogue (18 entries across
                                 fractions/decimals/percentages)
scripts/
  seedFirestore.ts              Demo-environment seed script (see step 4 above)
```

## Data model

- **`misconceptions/{id}`** - the catalogue in `src/data/misconceptions.json`:
  name, plain-language label, remediation approach, severity
  (`foundational` / `procedural` / `conceptual`), prerequisite misconception,
  each in English and Bahasa Melayu.
- **`studentProgress/{studentUid}_{classId}_{topic}`** - one document per
  student per topic (see `src/lib/helpers.ts`): tier, active misconceptions
  (with occurrence count and a computed persistence score), mastery score,
  transfer-question status. Tier is always derived from these fields via
  `calculateTier`, never stored independently of them.
- **`answers`** - one document per historical answer: correctness, transfer
  question flag, misconception classification, confidence level, timestamp.
- **`users/{uid}`** - role (`teacher`/`student`), name, class, language.
- **`classes/{classId}`** - name, subject, topics, kiosk mode, kiosk code.

> **Note:** the kiosk flow (`src/lib/studentProgress.ts`) currently uses a
> different, older progress-document shape (one doc per student holding all
> topics) than the one above. They haven't been reconciled yet, see Known
> limitations.

## Known limitations

- **Two `studentProgress` schemas coexist.** `src/lib/helpers.ts` (one doc
  per student per topic, used by the teacher dashboard) and
  `src/lib/studentProgress.ts` (one doc per student, all topics, used by the
  kiosk flow) were built independently and haven't been unified.
- **`src/app/api/capsule/generate/route.ts`** exports `generateCapsuleHTML`
  and a `CapsuleResponse` type alongside its route handler - Next.js route
  files may only export the HTTP method handlers plus a small allowlist of
  config constants, so this currently fails `next build`'s type check.
- No teacher-facing UI yet for creating a new class or account - the seed
  script is the only way to get a demo class into a fresh Firebase project.

## Learn more

- [Next.js Documentation](https://nextjs.org/docs)
- [Firebase Documentation](https://firebase.google.com/docs)
- [Gemini API / AI SDK](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)
