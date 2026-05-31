# FC Postgres Cutover Runbook

Switches the `teamclaw-sync` Function Compute function from the Supabase backend
(`BACKEND_KIND` unset or `supabase`) to the self-hosted Postgres backend
(`BACKEND_KIND=postgres`).

---

## Prerequisites

### Infrastructure

| Resource | Notes |
|---|---|
| Alibaba RDS for PostgreSQL ≥ 14 (or PolarDB PG) | VPC-accessible from FC; `cn-shenzhen` recommended to keep latency low |
| OSS bucket for attachments | Reuses the `teamclaw-team` bucket; uploads go under the `attachments/` prefix (no new bucket needed) |
| SMTP relay | For OTP email sign-in. Any SMTP provider (e.g. Alibaba DirectMail, Resend, SendGrid) |
| Apple OAuth app | `Sign in with Apple` — Service ID + private key (for `APPLE_CLIENT_SECRET` generation) |
| Google OAuth app | Google Cloud console → OAuth 2.0 client (Web application) |

### Local tooling

```bash
node --version   # >= 20
npm --version    # >= 10
# Serverless Devs CLI (installed by deploy.sh if missing):
s --version
```

---

## Step 1 — Apply Drizzle Migrations to RDS

Run from the repo root (worktree or main checkout):

```bash
cd services/fc

# Option A: drizzle-kit migrate (preferred — idempotent, tracks migration state)
DATABASE_URL="postgresql://USER:PASS@HOST:5432/DB" npx drizzle-kit migrate

# Option B: apply SQL files in order (for environments without drizzle-kit access)
for f in src/db/migrations/[0-9]*.sql; do
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f"
done
```

Migration files (apply in lexicographic order):

```
src/db/migrations/0000_daffy_unus.sql           — core tables (teams, actors, sessions…)
src/db/migrations/0001_marvelous_lucky_pierre.sql
src/db/migrations/0002_bored_sally_floyd.sql     — full domain schema + actor_directory view
src/db/migrations/0003_complex_synch.sql
src/db/migrations/0004_dusty_moira_mactaggert.sql
src/db/migrations/0005_ordinary_skrulls.sql
src/db/migrations/0005_telemetry_feedback_unique.sql
```

The `actor_directory` view is created by migration `0002`. Verify it exists after applying:

```sql
SELECT COUNT(*) FROM actor_directory;
```

---

## Step 2 — Environment Variables

Set the following in `.env.local` (or equivalent secrets store) before deploying with `BACKEND_KIND=postgres`.

### Always required (both backends)

```
ACCESS_KEY_ID=...
ACCESS_KEY_SECRET=...
ROLE_ARN=...
PUSH_WEBHOOK_SECRET=...
APNS_PRIVATE_KEY_P8=...
APNS_KEY_ID=...
APNS_TEAM_ID=...
APNS_TOPIC=...
APNS_ENV=production
MQTT_BROKER_URL=...
MQTT_USERNAME=...
MQTT_PASSWORD=...
```

### Postgres-specific (required when BACKEND_KIND=postgres)

```
BACKEND_KIND=postgres

# RDS / PolarDB connection string
DATABASE_URL=postgresql://USER:PASS@HOST:5432/DB?sslmode=require

# Better-Auth
AUTH_SECRET=<random 32+ char secret — generate with: openssl rand -base64 32>
AUTH_BASE_URL=https://cloud.ucar.cc

# Connection pool (FC is single-threaded per instance; 1 is safe; raise if using provisioned concurrency)
PG_POOL_MAX=1

# OTP email (optional but strongly recommended — OTP sign-in won't work without it)
OTP_EMAIL_SMTP_HOST=smtp.example.com
OTP_EMAIL_SMTP_PORT=465
OTP_EMAIL_SMTP_USER=no-reply@example.com
OTP_EMAIL_SMTP_PASS=...
OTP_EMAIL_SMTP_FROM=TeamClaw <no-reply@example.com>

# Apple Sign In
APPLE_CLIENT_ID=com.example.teamclaw
APPLE_CLIENT_SECRET=<JWT signed with Apple private key>

# Google Sign In
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

### Supabase vars (keep set — needed for supabase mode + legacy /sync/* paths)

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...
```

---

## Step 3 — Staged Rollout

### Stage 0 — Baseline (supabase mode, no change)

Deploy as-is without `BACKEND_KIND` set. Verifies the deploy pipeline is healthy before any backend switch.

```bash
bash .claude/skills/fc-deploy/deploy.sh
```

Smoke: `curl https://cloud.ucar.cc/healthz` → 200.

### Stage 1 — Staging / preview FC (postgres mode)

1. Provision a separate FC function (e.g. `teamclaw-sync-staging`) or use a preview environment.
2. Set all postgres env vars above. Do NOT set `BACKEND_KIND` on prod yet.
3. Deploy to staging and run the smoke suite:

```bash
BASE=https://staging.cloud.ucar.cc   # adjust to your staging endpoint

# Anonymous sign-up + sign-in
curl -X POST $BASE/auth/sign-up/email -d '{"email":"...","password":"...","name":"Test"}'
curl -X POST $BASE/auth/sign-in/email -d '{"email":"...","password":"..."}'
TOKEN=<session token from sign-in>

# OTP flow
curl -X POST $BASE/auth/email-otp/send-verification-otp -d '{"email":"test@example.com"}'
# (check inbox, then:)
curl -X POST $BASE/auth/email-otp/verify-otp -d '{"email":"test@example.com","otp":"123456"}'

# Teams / sessions / messages CRUD
curl -H "Authorization: Bearer $TOKEN" $BASE/v1/teams
TEAM_ID=<from above>
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/v1/teams/$TEAM_ID/sessions -d '{"name":"Test"}'
SESSION_ID=<from above>
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/v1/sessions/$SESSION_ID/messages -d '{"content":"hello"}'

# Attachment upload + download
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/v1/attachments/upload-url -d '{"filename":"test.txt","contentType":"text/plain"}'
# PUT to the presigned URL, then GET the download URL

# Sync versions
curl -H "Authorization: Bearer $TOKEN" "$BASE/sync/versions?teamId=$TEAM_ID&path=skills/"
```

### Stage 2 — OAuth validation (deferred; requires real Apple/Google creds)

- Test Apple `id_token` sign-in via POST `/auth/sign-in/social` with `provider=apple`.
- Test Google `id_token` sign-in via POST `/auth/sign-in/social` with `provider=google`.
- Verify PKCE flow end-to-end from a client app.

These are marked deferred-in-tests in Plan 4 and should be validated before prod cutover if Apple/Google sign-in is in use.

### Stage 3 — Production flip

Once staging passes:

1. Set `BACKEND_KIND=postgres` (and all postgres vars) in prod `.env.local`.
2. Run deploy:

```bash
bash .claude/skills/fc-deploy/deploy.sh
```

3. Verify prod healthcheck and repeat the smoke suite against `https://cloud.ucar.cc`.

### Rollback

Unset `BACKEND_KIND` (or set to `supabase`) and redeploy. The Supabase backend remains fully functional — no data migration is required for rollback (the postgres DB is write-ahead, so replaying from Supabase state requires a separate migration if you need data parity).

---

## Out-of-Scope Follow-Ups (still on Supabase after this cutover)

The following subsystems continue to call Supabase directly even after `BACKEND_KIND=postgres` is set. They must be migrated before `supabase-repo.mjs`, `@supabase/supabase-js`, and the `BACKEND_KIND` switch can be removed entirely.

| Subsystem | Location | Blocking item |
|---|---|---|
| Legacy `/sync/*` API (OSS-sync) | `services/fc/src/sync/` | Reads/writes `amuxc_*` tables via Supabase client |
| OSS-sync subsystem (`amuxc_*` tables) | `services/fc/src/sync/supabase-repo.mjs` (legacy) | Needs Drizzle schema + pg-repo equivalents for `amuxc_versions`, `amuxc_snapshots`, etc. |
| `pg_cron` cleanup jobs | Supabase dashboard / `services/supabase/` | Session/message expiry crons; must be ported to RDS pg_cron or a scheduled FC function |
| `dispatchPush` helper RPCs | `push_idempotency_claim`, `list_session_push_targets` Postgres functions called via Supabase RPC | Must be ported to direct SQL / Drizzle calls in `src/push/` |

Only after ALL of the above are migrated:

1. Delete `services/fc/src/db/supabase-repo.mjs` (or equivalent).
2. Remove `@supabase/supabase-js` from `package.json`.
3. Remove the `BACKEND_KIND` switch and the Supabase env var block from `s.yaml` + `deploy.sh`.
