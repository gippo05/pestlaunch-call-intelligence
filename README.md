# PestLaunch Call Intelligence

A small AI-powered call review application built for the PestLaunch engineering challenge.

The goal is to help a business owner review customer conversations without having to listen to every recording from start to finish. The app organizes calls, transcribes conversations, extracts important details, and gives reviewers a starting point for evaluating call handling.

> **Demo data:** I used synthetic recordings only. Although real customer calls were provided for the assessment, I chose to avoid using personal customer information during development and demonstration.

## What the app does

- **Private call uploads:** Signed-in reviewers can upload MP3 recordings and see their processing status in a call library.
- **AI transcription and analysis:** When processing is configured, Gemini produces a transcript, speaker suggestions, call classification, customer concerns, key facts, and an outcome summary.
- **Evidence-based review:** Extracted details can be checked against the saved transcript rather than treating AI output as automatically correct.
- **Reviewer-assisted scorecards:** Sales, General Office, and Retention criteria are based on the provided scorecard framework. Reviewers can assess criteria and attach transcript evidence. Results are provisional until calibration and human review requirements are met.
- **Review prompts:** The interface highlights possible concerns and follow-up areas, with the understanding that these are suggestions—not approved coaching decisions.

## Tech stack and architecture

| Part | Technology | Reason for choosing it |
| --- | --- | --- |
| Web app | Next.js, React, TypeScript, Tailwind CSS | Familiar stack for building a responsive application quickly |
| Authentication and database | Supabase Auth and PostgreSQL | Manage users, calls, analysis, and review data together |
| Audio storage | Supabase private Storage | Avoid exposing recordings through public URLs |
| Background processing | Supabase Edge Functions and database queue | Keep AI work separate from the upload request |
| AI | Google Gemini | Transcription and structured call analysis |
| Scoring | TypeScript rules and reviewer worksheet | Keep scoring consistent and allow human verification |
| Hosting | Vercel for the web app; Supabase for backend services | Straightforward deployment for an MVP |

**High-level flow:**

`Sign in → Upload MP3 → Private Storage → Processing queue / Edge Function → Gemini → Saved transcript and extracted details → Human review and provisional scorecard`

I separated uploading, AI processing, and scoring so that each part can be tested and improved independently. I also chose to keep AI suggestions separate from final scoring: a model can help identify possible evidence, but it should not automatically give an employee a final grade based on uncertain speaker attribution or incomplete analysis.

## Local setup

**Requirements:** Node.js 22.13+ (or a supported 24.x/26.x version), npm, Docker Desktop, and Supabase CLI.

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/gippo05/pestlaunch-call-intelligence.git
   cd pestlaunch-call-intelligence
   npm ci
   ```

2. Start local Supabase and apply the project migrations:

   ```bash
   supabase start
   supabase migration up --local --yes
   ```

3. Copy `.env.example` to `.env.local` and fill in the **local** Supabase URL and keys shown by `supabase status -o env`. The main settings are:

   ```dotenv
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local-publishable-key>
   SUPABASE_SECRET_KEY=<local-secret-key>
   M3_PROCESSING_ENABLED=false
   M3_SYNTHETIC_ONLY=true
   M3_WORKER_AUTH_SECRET=<private-worker-secret-if-enabling-processing>
   ```

   Keep secrets out of Git and never put a server secret in a `NEXT_PUBLIC_` variable.

4. Start the application:

   ```bash
   npm run dev
   ```

   Open `http://localhost:3000`.

5. Provision a Supabase Auth user and workspace membership. Public sign-up is intentionally disabled, so an authorized owner must create reviewer access.

**AI processing:** Local processing is disabled by default. To test the full AI pipeline, the M3 Edge Function, trusted worker authentication, and Gemini credentials/model must also be configured explicitly. Simply starting Next.js and Supabase does **not** enable transcription. The project intentionally does not include working API keys.

**Checks:**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Known limitations

- **Not a fully finished product.** The core call-review experience is implemented, but some of the more advanced coaching and product insights from the assessment are still limited.
- **Scoring needs human review and calibration.** AI can suggest possible evidence, but official numeric grades are withheld until the rubric and evidence requirements are satisfied. A completed reviewer worksheet can show a clearly labeled provisional result.
- **AI output needs verification.** Transcription, speaker labels, classification, and extracted details may be inaccurate, especially with noisy or overlapping speech.
- **Processing reliability needs more testing.** Provider errors, timeouts, and queued or stalled jobs still need stronger production monitoring and recovery flows. The full hosted end-to-end flow should be verified against the final deployed revision.
- **Audio playback is not yet part of the review experience.** Reviewers currently rely on saved transcript evidence.
- **Synthetic recordings only were used for this assessment.** Real customer data handling, consent, retention, and production privacy controls would need a separate review before broader use.

## What I would do next

1. **Improve analysis and coaching:** Surface clearer missed opportunities, actionable recommendations, and priorities for business owners.
2. **Calibrate the scoring system:** Validate rubrics with real reviewers and representative, authorized recordings before issuing official grades.
3. **Improve reliability:** Add safe retries, better job monitoring, clearer error messages, and more end-to-end tests.
4. **Improve the review experience:** Add authorized private audio playback, transcript navigation, and simpler ways to approve or correct AI suggestions.
5. **Prepare for real customer use:** Review access controls, retention/deletion policies, consent requirements, and model-provider privacy terms.

## Final note

For this challenge, I prioritized a usable call-review workflow and a structure that can be improved in stages. Some areas are unfinished, and I have tried to be clear about those limitations rather than present the app as production-ready.
