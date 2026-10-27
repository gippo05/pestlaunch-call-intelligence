# M1 security boundaries

## Authentication

The browser and server use `@supabase/ssr` request-scoped clients and only the project URL plus publishable key. `proxy.ts` refreshes cookies with `auth.getClaims()`. The protected route layout verifies claims again on the server and confirms a visible membership row before rendering the app. Server-rendered pages still rely on database RLS for access control.

Sign-in accepts only email/password; errors are generic, and password values are neither normalized nor included in errors. There is no sign-up action. Sign-out revokes the Supabase session and returns to the sign-in page. No service-role or `sb_secret_` key is read by application code.

## Database authorization

All seven public tables enable RLS. Anonymous table access is revoked. Authenticated clients have read-only grants for user-facing tables; internal jobs have no client grants or policy. Policies bind workspace records to `auth.uid()`-derived membership and child records to their parent call. Membership role and workspace assignment cannot be changed through the Data API.

The migration never trusts user-editable metadata and adds no policy that allows a caller to create membership. Workspace membership is provisioned by an owner through an administrative path, outside this client.

## Development data

No recordings are uploaded or sent to Gemini. There is no storage bucket or analysis worker in M1. Local seed loading and local Supabase sign-up are disabled. Do not copy `.env` files or customer information into this repository or reports.

## Verification boundary

The remote catalog assertions in `supabase/tests/m1_permissions.sql` passed for anonymous grants, client write grants, internal queue access, RLS flags, and helper-function ACLs. The transaction-only test in `supabase/tests/m1_rls_behavior.sql` passed for two synthetic JWT subjects and verified workspace, call, analysis, and score isolation. The fixture Auth rows and application rows were rolled back, and a separate query confirmed every emitted fixture ID was absent.

The production-build browser check redirected both an unauthenticated request and a forged local cookie from `/calls` to `/login`. The browser had zero console errors or warnings. These checks do not verify a signed Supabase JWT or actual password authentication. No authorized assessment account was provided, so real sign-in/sign-out and membership-based page access remain pending before M2.
