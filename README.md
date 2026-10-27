# PestLaunch Call Intelligence

Private App Router application for the PestLaunch engineering assessment. This repository stops at M1: secure sign-in, a protected workspace shell, an empty Calls view, a Scorecards placeholder, and the additive database foundation.

## Local setup

Requirements: Node.js 22.13+, 24.x, or 26+ and npm 12.2.1.

1. Copy `.env.example` to `.env.local`.
2. Set only the authorized project's Supabase URL and `sb_publishable_` key. A Supabase secret or service-role key must never be placed in a `NEXT_PUBLIC_` variable or this frontend repository.
3. Install and start the app:

   ```powershell
   npm ci
   npm run dev
   ```

Open [http://localhost:3000](http://localhost:3000). Missing or malformed public configuration fails with a generic message and does not echo the supplied value.

## Assessment access

There is no registration route or account creation flow. An owner must manually authorize an assessment account and add its Auth user ID to `workspace_members`. A signed-in user without a membership is sent back to the access page. The database has no seeded users or workspace records.

The application expects the M1 migration to be applied to the exact authorized project `aznfcxrlpzjnssfatzxi` before sign-in can reach the protected shell. The SQL source is under `supabase/migrations/`; the migration does not change Auth configuration, extensions, Edge Functions, Storage, or unrelated project resources. For local database development, `supabase/config.toml` disables sign-ups and seed loading.

## Milestone boundary

M1 does not upload, store, transcribe, score, or process recordings. The Calls action is disabled, and Scorecards and processing are explicitly labeled as later work. Do not use real customer recordings in development. The migration stores metadata fields and a future workspace-scoped object path; it does not create a Storage bucket.

## Commands

```powershell
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

See `docs/database.md`, `docs/security.md`, and `docs/onboarding.md` for schema, access boundaries, and the manual owner setup path.
