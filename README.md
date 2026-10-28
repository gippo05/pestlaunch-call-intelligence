# PestLaunch Call Intelligence

Private App Router application for the PestLaunch engineering assessment. M1 provides sign-in, a protected workspace shell, Scorecards placeholder, and the additive database foundation. M2 adds local synthetic MP3 ingestion and a guarded queue worker; hosted M2 resources remain unactivated.

## Local setup

Requirements: Node.js 22.13+, 24.x, or 26+ and npm 12.2.1.

1. Copy `.env.example` to `.env.local`.
2. Set the authorized project's URL and `sb_publishable_` key. For local M2 uploads, set `SUPABASE_SECRET_KEY` to a modern server-only `sb_secret_` key. Never place it in a `NEXT_PUBLIC_` variable or commit a real value.
3. Install and start the app:

   ```powershell
   npm ci
   npm run dev
   ```

Open [http://localhost:3000](http://localhost:3000). Missing or malformed public configuration fails with a generic message and does not echo the supplied value.

## Assessment access

There is no registration route or account creation flow. An owner must manually authorize an assessment account and add its Auth user ID to `workspace_members`. A signed-in user without a membership is sent back to the access page. The database has no seeded users or workspace records.

The application expects the M1 migration to be applied to the exact authorized project `aznfcxrlpzjnssfatzxi` before sign-in can reach the protected shell. The SQL source is under `supabase/migrations/`; the migration does not change Auth configuration, extensions, Edge Functions, Storage, or unrelated project resources. For local database development, `supabase/config.toml` disables public sign-up and seed loading while allowing administrator-provisioned email/password users to sign in.

## Milestone boundary

M2 accepts synthetic MP3 fixtures up to 50 MiB through an authenticated browser-to-private-Storage transfer. Next.js authorizes the workspace, prepares the upload lease, and finalizes the verified object; audio bytes do not pass through a Next.js function, and no signed-upload token is returned. The M2 migration is prepared locally and has not been applied to the hosted project. The worker defaults to a disabled synthetic processor; normal uploads remain queued for M3. Transcription, scoring, and coaching are not implemented. Do not use customer recordings in development.

M1 authentication passed and **M2 local integration is certified PASS**: PostgreSQL 17.6 migrations, SQL/RLS, two-worker concurrency, authenticated Storage, real browser upload and live Edge worker all passed. See `docs/M2-local-integration-QA-20261027.md` and `docs/M2-edge-runtime-certification-20261028.md`. Hosted M2 is **not deployed**. Do not apply the hosted migration, deploy the hosted worker, configure hosted secrets, or activate Cron without a separate release decision. The Cron activation file under `supabase/cron/` remains preparation only.

## Commands

```powershell
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

See `docs/M2-implementation-design.md`, `docs/M2-implementation-report.md`, `docs/database.md`, `docs/security.md`, and `docs/onboarding.md` for the M2 design, evidence, access boundaries, and owner gates.
