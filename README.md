# PestLaunch Call Intelligence

PestLaunch is a private call-review MVP built with Next.js, Supabase, and a bounded Gemini transcription worker. Local M1–M5 foundations include authenticated uploads, exact-hash synthetic fixture gating, transcript and outcome review, deterministic scorecard gates, and a call library. Hosted deployment and real customer audio are outside this local delivery.

## Local setup

Requirements: Node.js 22.13+, 24.x, or 26+, npm 12.2.1, Supabase CLI, and Docker Desktop.

1. Start the local Supabase stack and apply migrations to that stack only:

   ```powershell
   supabase start
   supabase migration up --local --yes
   ```

2. Copy `.env.example` to `.env.local`. Set the Supabase URL to `http://127.0.0.1:54321`, then use the publishable and secret keys reported by `supabase status -o env`. Keep the secret key server-only. Do not copy production credentials into a local file.
3. Install and start the app:

   ```powershell
   npm ci
   npm run dev
   ```

Open [http://localhost:3000](http://localhost:3000). There is no public registration flow. A local workspace owner must provision an Auth user and add that user to `workspace_members` before protected pages or upload are available.

The `.env.example` defaults `M3_PROCESSING_ENABLED=false`. Upload finalization still verifies and stores the exact private MP3. With M3 disabled, the call remains queued and no Gemini request is made. The local-only helper `scripts/setup-m3-local.ps1` also leaves processing disabled by default. Its `-EnablePaidGemini` switch is an explicit local runtime opt-in; it does not make a provider request itself. On October 30, one explicitly authorized local Gemini run processed call `bf024624-1147-421f-81b7-53e9e4bd674b`; that single-run approval is consumed. The temporary enabled Edge session has been stopped. No further provider request is authorized by that approval.

For local Edge testing, `scripts/serve-m3-local.ps1` reads only an allowlist from the Git-ignored root `.env`, maps `GEMINI_API_KEY` to `M3_GEMINI_API_KEY`, and supplies `gemini-3.8-flash`. Its default keeps processing disabled; its startup log reports only secret presence, never a key value. The one approved run reached Gemini, saved its transcript and unreviewed outcome/fact/concern candidates, and completed its one-attempt job. The local worker is stopped after that run. If an enabled worker has no key or model, it fails closed as `provider_not_configured`.

## Integrated workflow

1. An authenticated reviewer uploads an MP3 directly from the browser to the private Storage bucket. The server checks the upload lease, MIME type, size, and MP3 signature before finalizing the call record.
2. When local M3 processing is explicitly enabled, the server hashes the verified private bytes and asks a service-role-only database function to authorize only an exact registry match. New demo jobs are capped at one attempt.
3. The server sends a short-timeout HMAC request to the local Supabase worker, signed for the exact call ID. An optional, disabled-by-default `M3_HOSTED_SYNTHETIC_DISPATCH_ENABLED=true` additionally permits the exact PestLaunch Test hosted URL only, retaining synthetic-only/verified-hash one-attempt authorization. Neither mode enables general real-customer processing. The worker re-downloads the object and verifies the registered digest before any Gemini call.
4. Optional queue recovery: after deployment, an operator may explicitly configure a trusted scheduler to invoke `GET /api/internal/m3-synthetic-pump` with a protected `CRON_SECRET`. It scans a bounded list of pending synthetic jobs and triggers no more than one approved HMAC-targeted dispatch per invocation. The route is inert without the processing flags and correct Supabase project target. It is not scheduled by default and was not provider-tested in hosted infrastructure. Transcript, extracted facts and concerns, classification, and outcome are saved as unreviewed analysis candidates. Future processed calls also retain model-suggested speaker spans in private quality metadata. The M4 pre-assessment derives evidence-linked **potentially met** handling cues from these utterances without a second model call; the original saved Gemini call predates this change and has no speaker cues. The Calls page and call detail refresh for a bounded period while processing is queued or active.
5. M4 stores an all-withheld AI candidate assessment bound to a saved M3 analysis. The suggested cues appear in the call detail and can prefill—but **cannot approve**—the criterion evidence. Workspace owners/reviewers use the **Reviewer-assisted QA worksheet** to mark each manual criterion, attach a verbatim transcript excerpt, affirm actual employee speaker attribution, and save a separate review draft. The worksheet shows coverage, confirmed draft points, and a provisional grade band only after the whole call and all applicable criteria are assessed. Four Sales objection-handling points are automatically credited only after whole-call review explicitly confirms no objection. This worksheet is not an official score, does not change the M3 analysis review status, and never bypasses rubric calibration.
6. M5 shows exact-evidence-linked reviewer prompts from concern and outcome candidates. These prompts are explicitly provisional and do not attribute behavior to an employee. Official coaching remains gated on an approved human-reviewed scorecard.

**Current limitation:** M4 does **not** automatically produce a complete numeric PestLaunch grade after upload. Automatic cues are partial model-sourced review suggestions; unknown or missing cues are not evidence of a failed criterion. A human-reviewed, complete rubric worksheet can produce a clearly labeled provisional band. Official grades require approved rubric calibration and validated source/speaker attribution. Audio playback remains unavailable until an authorized private-media read flow is configured. Files and database records are workspace scoped. Use synthetic fixtures only.

## Verification commands

```powershell
npm test
npm run typecheck
npm run lint
npm run build
supabase test db --local
```

The SQL assertions under `supabase/tests/` are rollback-only. Keep local Vitest, local database, browser, CI, and hosted evidence separate in any handoff.

## Release boundary

This repository state is prepared for local review. It does not authorize a linked/hosted migration, Edge Function deployment, Vercel deployment, hosted secret change, real customer recording, or another paid Gemini request. Those require a separate explicit decision and their own preflight, backup, and verification evidence. See [the MVP delivery checklist](docs/mvp-delivery-checklist.md) for release gates and the demo outline.

## M6 submission preparation

Before submission, attach the local test, browser, and production-build evidence, identify the exact repository revision and target projects, and complete the release gates in the checklist. Do not describe local database, browser, or worker evidence as hosted or production evidence. Keep Gemini disabled by default. The October 30 approval covered one synthetic call and has been consumed; any additional provider run needs a new explicit approval. Keep real customer recordings out of this MVP review.
