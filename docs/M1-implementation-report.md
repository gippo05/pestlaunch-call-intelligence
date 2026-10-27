# PestLaunch Call Intelligence V1 — M1 implementation report

Date: 2026-10-27
Verdict: **CONDITIONAL PASS**

## A. Implementation summary

Built a standalone private Next.js App Router application at `D:\PROJECTS\Next JS projects\PestLaunch\pestlaunch-call-intelligence`. It includes a responsive sign-in page, cookie-based Supabase SSR clients, protected routes, a Calls empty state, a Scorecards placeholder, and the additive M1 database foundation. No call recordings, transcripts, or customer data were used.

The repository is on branch `m1-call-intelligence`. It has no commits (`HEAD` does not exist yet); all source changes are local. Nothing was pushed or deployed.

## B. Source tree

- `src/app/` — sign-in, protected Calls and Scorecards routes, and auth route handlers.
- `src/components/` — app shell, responsive navigation, sign-in form, and UI primitives.
- `src/lib/auth/` — credential validation and server-side claims/membership guard.
- `src/lib/supabase/` — browser and request-scoped server clients.
- `src/proxy.ts` — Next.js 16 session refresh and cookie forwarding.
- `supabase/migrations/20261027062949_m1_foundation.sql` — schema, grants, RLS, and helper functions.
- `supabase/migrations/20261027063558_m1_foreign_key_indexes.sql` — two advisor-identified foreign-key indexes.
- `supabase/tests/m1_permissions.sql` and `supabase/tests/m1_rls_behavior.sql` — catalog permissions and transactional two-subject RLS checks.
- `docs/database.md`, `docs/security.md`, `docs/onboarding.md` — schema, security, and manual owner setup.

## C. Database migrations

Both migrations were applied to the exact authorized project `PestLaunch Test` (`aznfcxrlpzjnssfatzxi`, `https://aznfcxrlpzjnssfatzxi.supabase.co`), which reported `ACTIVE_HEALTHY` on Postgres 17.11.

- `20261027062949_m1_foundation` created `private` and seven public tables: `workspaces`, `workspace_members`, `calls`, `analysis_jobs`, `call_analyses`, `rubric_versions`, and `call_scores`.
- `20261027063558_m1_foreign_key_indexes` added indexes for `calls(uploader_user_id)` and `analysis_jobs(workspace_id, call_id)`.
- Post-migration inspection found RLS enabled on all seven tables. All seven public tables contain zero rows; the migrations inserted no seed data, and the synthetic test Auth IDs were confirmed absent after rollback.
- No Storage bucket was created. The migrations do not change extensions, Auth settings, Edge Functions, or cron schedules.

## D. Security review

The catalog permission test passed remotely. Anonymous roles have no table `SELECT`; authenticated clients have `SELECT` on the six user-facing tables and no `INSERT`, `UPDATE`, or `DELETE` grants. `analysis_jobs` has no client grants and no policy. The membership helper is `SECURITY DEFINER`, uses an empty fixed `search_path`, and is executable by authenticated users only.

The two-subject behavioral SQL test passed under the `authenticated` database role with synthetic JWT claim settings. Each subject saw its own workspace, call, analysis, and score, and not the other subject’s rows. The test used synthetic Auth IDs and app rows in one transaction, then issued `ROLLBACK`; a follow-up query confirmed every returned fixture ID was absent.

The security advisor reports one informational `rls_enabled_no_policy` notice for `analysis_jobs`. That is intentional default-deny behavior and the queue also has no client grants. The performance advisor no longer reports unindexed foreign keys; it reports unused indexes on the empty schema, which is expected before workload exists.

## E. Authentication verification

The production build’s browser check redirected both an unauthenticated request and a forged local cookie from `/calls` to `/login`. The mobile page fit a 390×844 viewport without horizontal overflow; the desktop page was checked at 1440×900. The browser recorded zero console errors and zero warnings.

No authorized assessment account was supplied. A valid password sign-in/sign-out and membership-backed page access were not tested. The SQL RLS test simulates claims and does not validate JWT signatures or the Supabase Auth login flow.

## F. Test results

- `npm test` — PASS, 2 test files and 6 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS using Webpack; TypeScript completed, 9 static pages generated, and the expected `/api/auth/sign-in`, `/api/auth/sign-out`, `/calls`, `/login`, and `/scorecards` routes were emitted.
- `git diff --check` and source/config/docs trailing-whitespace scan — PASS.
- Browser screenshots: `output/playwright/login-production-mobile.png` and `output/playwright/login-production-desktop.png`.

The validation shell used Node 24.19.0 and npm 11.5.2. `package.json` declares `npm@12.2.1`; Corepack could not download that version because registry DNS was unavailable, so this final check did not exercise the declared npm version.

## G. Changes made remotely

The only persistent Supabase mutations were the two additive migrations above. Both M0.5 Edge Functions remain active at the same versions and hashes observed before the migration: `m05-cron-ping` v4 and `m05-dashboard-20m-benchmark` v3. The installed extensions, including `pg_cron`, `pg_net`, and Vault, were unchanged.

The behavioral test temporarily inserted two generated Auth ID rows and synthetic application fixtures inside a transaction. The explicit rollback succeeded, and a read-only cleanup query confirmed all fixture IDs were absent. No hosted Auth setting or project signup configuration was changed.

## H. Risks and decisions

- Real assessment-account authentication remains unverified; provide or manually authorize the account and complete sign-in/sign-out and membership checks before M2.
- Hosted Auth public-signup configuration was not changed or independently verified. The app has no signup route, and membership remains required for protected access; the owner should verify hosted signup settings before M2.
- Supabase reports one intentional informational queue-policy notice and unused-index notices on empty tables. The FK-index findings were resolved.
- The package declares npm 12.2.1 while the local shell exposed npm 11.5.2; the registry outage prevented rechecking with the declared package-manager version.
- The Webpack build path is explicit because the default Turbopack build could not launch a child process in this Windows sandbox.

## I. Next milestone readiness

**M2 should not begin yet.** M1 source and database boundaries are in place, but an owner-authorized assessment account must be used to verify real sign-in, sign-out, and membership-backed route access. Confirm hosted signup settings as part of that check. No M2 audio ingestion or Cron worker, M3 Gemini processing, M4 scoring logic, M5 dashboard, or M6 deployment work was started.
