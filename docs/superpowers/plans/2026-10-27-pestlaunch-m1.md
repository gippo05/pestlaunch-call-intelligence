# PestLaunch Call Intelligence M1 Implementation Plan

> **For agentic workers:** Implement this plan task by task against the supplied M1 request. Tests precede behavior code. Do not commit, push, deploy, or begin M2.

**Goal:** Build the private M1 Next.js application shell, cookie-based Supabase authentication, additive schema, and least-privilege RLS foundation.

**Status:** The M1 source and two approved additive migrations are complete on the exact authorized project. Account-level sign-in remains pending because no assessment account was supplied. Stop before M2.

**Architecture:** A standalone `src/app` Next.js App Router project uses Supabase Auth through `@supabase/ssr`. `proxy.ts` refreshes cookies; protected server layouts verify signed claims and database policies remain the data authorization boundary. The migration creates only M1 application objects in the authorized Supabase project.

**Tech Stack:** Next.js 16.4.3, React 19.3.1, TypeScript strict mode, Tailwind CSS 4, shadcn/ui, Supabase JS 2.118.0, `@supabase/ssr` 0.12.7, ESLint, Vitest.

**Spec:** `C:\Users\Gippo\.codex\attachments\a9a5eeee-78b0-4b39-9d1c-68a8405ff5d2\Pasted text.txt` (PESTLAUNCH CALL INTELLIGENCE V1 — M1 IMPLEMENTATION)

## Global Constraints

- M1 only; stop before M2 audio ingestion or Cron worker, M3 Gemini, M4 scoring logic, M5 complete dashboard, and M6 deployment.
- Preserve `D:\PROJECTS\Next JS projects\PestLaunch\m05-supabase-edge-spike` and its evidence, functions, and extensions.
- Use only the exact Supabase project `aznfcxrlpzjnssfatzxi`; recheck identity, collision state, and security immediately before applying an additive migration.
- Do not process or upload real customer recordings, use Gemini, expose secret/service-role keys, create public sign-up, enable billing, or create another Supabase project.
- Do not create a Storage bucket unless M1 auth testing requires it; no audio workflow is in scope.
- Do not commit, push, publish, contact the founder, or claim the assessment clock started.
- If an authorized test account is unavailable, report end-to-end sign-in as pending.

## Review Focus

- Forged or stale cookies must not grant protected access; verify claims server-side and test unauthenticated redirect behavior.
- A member must not read another workspace's calls, analyses, or scores; test RLS under distinct JWT subjects.
- Membership cannot be inserted, reassigned, or escalated by clients; expose no client write grants.
- Internal queue state must not be readable or mutable through the Data API.
- Missing or malformed public environment values must fail with a safe error that does not echo secrets.

## Visual and Interaction Direction

- **Visual thesis:** A calm, precise operations workspace with warm paper surfaces, deep ink typography, and one restrained amber accent.
- **Content plan:** Sign-in explains the private assessment workspace; the protected Calls view provides orientation and a factual empty state; a Scorecards placeholder marks the later milestone without implying generated results.
- **Interaction thesis:** Responsive sidebar navigation, clear keyboard focus, and immediate form feedback; no decorative motion is needed for this utility surface.

---

### Task 1: Application foundation and reproducible setup

**Files:** package manifest and lockfile, Next/Tailwind/TypeScript/ESLint configuration, `components.json`, `.gitignore`, `.env.example`, `README.md`, `supabase/config.toml`, and this plan.

- [x] Scaffold the App Router project with strict TypeScript, Tailwind, ESLint, pinned dependencies, and a package lockfile.
- [x] Configure the shadcn/ui component system and `src/*` import alias.
- [x] Add safe example-only Supabase public environment variables and setup documentation; never add credentials.
- [x] Confirm Git status, Node/dependency versions, and the production build inputs. The package manager is declared as npm 12.2.1; the local shell used npm 11.5.2 because Corepack could not reach the registry.

### Task 2: Environment and authentication boundaries

**Files:** `src/lib/env/public.ts`, `src/lib/env/public.test.ts`, `src/lib/supabase/{browser,server}.ts`, root `proxy.ts`, `src/lib/auth/{session,credentials}.ts`, and tests.

- [x] Write tests for valid/invalid environment parsing and credential validation; all six unit tests pass.
- [x] Implement browser and server Supabase clients with request-scoped cookie access and `getClaims()` verification.
- [x] Implement a server-only `requireUser()` guard and session refresh in Next.js 16 `proxy.ts`.
- [x] Implement password sign-in and sign-out actions only; do not add sign-up.
- [x] Run unit tests and strict type checking.

### Task 3: Additive M1 database foundation

**Files:** timestamped `supabase/migrations/*_m1_foundation.sql` and `*_m1_foreign_key_indexes.sql`, catalog and behavioral RLS checks in `supabase/tests/`, and schema notes in `docs/database.md`.

- [x] Create two versioned additive SQL migrations for the M1 schema and advisor-identified FK indexes.
- [x] Define workspaces, memberships, calls, analysis jobs, analyses, rubric versions, and call scores with explicit constraints and indexes.
- [x] Enable RLS everywhere; grant authenticated clients SELECT only on user-facing tables; grant no direct access to internal job rows or client writes.
- [x] Use a private, fixed-search-path membership helper to avoid recursive membership policies; enforce child access through parent calls.
- [x] Independently review both migrations and the transaction-only behavioral RLS test before remote execution.
- [x] Re-run exact-project and object-collision preflight before each additive migration.
- [x] Verify objects, grants, policies, and advisors; run catalog checks and two-subject SQL RLS isolation with rollback cleanup verification.

### Task 4: Private M1 application UI

**Files:** `src/app/layout.tsx`, login route/action/form, protected route layout, Calls and Scorecards pages, shared shell/navigation, and a small set of shadcn/ui primitives.

- [x] Implement the login page with accessible validation and generic credential errors.
- [x] Implement a protected responsive app shell with logout and a truthful Calls empty state.
- [x] Render a truthful empty Calls state and an explicit Scorecards/processing placeholder with no synthetic customer data.
- [x] Verify mobile/desktop layout, anonymous and forged-cookie denial, and a clean browser console. Valid-account sign-in and in-app navigation remain pending.

### Task 5: M1 handoff and verification

**Files:** `README.md`, `.env.example`, `docs/security.md`, `docs/database.md`, and `docs/M1-implementation-report.md`.

- [x] Document manual assessment-account setup, local configuration, migration replay, and the private storage plan for a later milestone.
- [x] Run tests, ESLint, strict TypeScript, production build, and `git diff --check`; retain exact outcomes.
- [x] Recheck branch/status; keep generated test identities transactional and avoid credentials or M0.5 source copies.
- [x] Produce the requested structured report and final CONDITIONAL PASS verdict, then stop at M1.
