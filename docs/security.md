# M1 and M2 security boundaries

## Authentication

The browser uses the project URL and modern publishable key. `proxy.ts` refreshes cookies with `auth.getClaims()`. The protected route layout verifies claims again on the server and confirms a visible membership row before rendering the app. Server-rendered pages still rely on database RLS for access control.

Sign-in accepts only email/password; errors are generic, and password values are neither normalized nor included in errors. There is no sign-up action. Sign-out revokes the Supabase session and returns to the sign-in page. **M1 browser code** uses no elevated keys. **M2 server-only upload handlers** read `SUPABASE_SECRET_KEY` in `src/lib/supabase/admin.ts`; the browser never receives this key.

## Database authorization

All seven M1 public tables enable RLS. Anonymous table access is revoked. Authenticated clients have read-only grants for user-facing tables; internal jobs have no client grants or policy. Policies bind workspace records to `auth.uid()`-derived membership and child records to their parent call. Membership role and workspace assignment cannot be changed through the Data API.

The migration never trusts user-editable metadata and adds no policy that allows a caller to create membership. Workspace membership is provisioned by an owner through an administrative path, outside this client.

## M2 upload boundary

- The authenticated route verifies Supabase claims and re-reads the caller's own membership. Only `owner` and `reviewer` roles can create or use an upload intent; the client cannot supply a user ID, workspace ID, or object path.
- `SUPABASE_SECRET_KEY` is read only by the server-only admin module. Because it bypasses RLS, every privileged operation is scoped again by authenticated user ID, workspace membership, intent ownership, fixed intent path, and allowed state. It is not sent to the browser.
- Next.js authenticates the user, checks workspace membership, creates the upload intent, and prepares a server-side lease. The signed-in browser sends bytes directly to the private Storage API using its existing Supabase access token; Next.js does not proxy audio or return a signed-upload token. The Storage `INSERT` policy checks `auth.uid()`, writable membership, exact generated path, active intent, and active lease. M2 adds no Storage read, update, or delete policy.
- Server-side checks enforce MP3 metadata, a 50 MiB maximum, and an MP3 frame/ID3 signature. Finalization downloads the object through the server-only client and checks stored bytes, size, and content type before the atomic RPC creates a `queued` call and `pending_m3` job. The RPC fences finalization by the active upload lease and duplicate finalization returns the same call.
- Abandoned cleanup first marks an expired intent `abandoned`; finalization rejects abandoned intents. A token-fenced cleanup lease serializes workers; cleanup deletes only the recorded path and marks it cleaned after Storage succeeds. An interrupted object never creates a call or completed job.

## M2 worker and Cron boundary

- The Edge Function uses the Supabase server wrapper's platform-provided admin client. The handler still checks an independent high-entropy HMAC secret, timestamp window, and one-use UUID nonce before cleanup or queue work. The raw secret is never embedded in source.
- `pg_cron` uses only the publishable `apikey`. PostgreSQL computes a short-lived HMAC proof from a Vault secret; `pg_net` queues that proof and nonce, not the raw worker secret or an elevated Supabase key. The private request-ID table stores only IDs; the prepared inspection query omits request headers and response bodies.
- The worker claims one job with a fixed lease, verifies the call/workspace linkage, and only handles `m2_synthetic_test` when `M2_TEST_PROCESSOR_ENABLED=true`. Ordinary `pending_m3` jobs stay queued. Synthetic results are labeled as tests, and logs include only fixed event/outcome strings.
- The activation SQL is prepared but unexecuted. No hosted M2 migration, bucket, function deployment, hosted secret, or Cron schedule was changed. M1 authentication and M2 local integration gates both passed; hosted activation remains a separate release decision.

## Development data

Use synthetic recordings only. No Gemini, transcription, scoring, or customer audio processing is implemented. M2's private bucket and Edge worker have been tested in an isolated local Supabase environment and are not activated on the hosted project. Local seed loading and public sign-up are disabled; administrator-provisioned email/password login is enabled locally. Do not copy `.env` files or customer information into this repository or reports.

## Verification boundary

The remote catalog assertions in `supabase/tests/m1_permissions.sql` passed for anonymous grants, client write grants, internal queue access, RLS flags, and helper-function ACLs. The transaction-only test in `supabase/tests/m1_rls_behavior.sql` passed for two synthetic JWT subjects and verified workspace, call, analysis, and score isolation. The fixture Auth rows and application rows were rolled back, and a separate query confirmed every emitted fixture ID was absent.

The production-build browser check redirected both an unauthenticated request and a forged local cookie from `/calls` to `/login`. The browser had zero console errors or warnings. Those checks did not verify a signed Supabase JWT or password authentication. The architecture owner later confirmed real M1 sign-in/sign-out, membership access, and disabled public signup in the 2026-10-27 M2 correction handoff; this task relied on that confirmation and did not repeat M1 discovery.
