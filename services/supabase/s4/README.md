# S4 — Transplant teamclaw `amux` into saas-mono

Moves teamclaw's DB objects from **47.x (SRC)** into **saas-mono (DST)**, the
final step of the teamclaw × saas-mono integration. Schema-only (no data).

See the full plan: `docs/specs/2026-06-08-teamclaw-saas-mono-integration.md` (Step D).

## What gets transplanted

| From SRC | To DST | Notes |
|---|---|---|
| `amux` schema (35 tables + `actor_directory` view + indexes/FKs/triggers/RLS) | `amux` (new) | teamclaw-owned, no collision |
| `app` schema (RLS helper functions: is_team_member, current_org_id, …) | `app` | teamclaw-owned; warn if DST already has `app` |
| teamclaw `public` functions (create_team(p_oid), claim_team_invite, ensure_personal_org, amux_access_token_hook, amux_acl_rules_for, the 41 RPCs, …) | `public` | CREATE OR REPLACE — collision report in step 0b |
| `orgs_view_policy` on `public.orgs` | `public.orgs` | teamclaw RLS on saas-mono's real orgs table |

**NOT transplanted** (saas-mono already owns the real tables): `public.orgs`,
`public.plans`, `public.users` — only the teamclaw *policy/columns* they need.
On DST these must already exist (saas-mono's real DDL).

## Prerequisites

- `pg_dump` + `psql` (PostgreSQL 18 client) on the machine running the script.
- Network access to both DBs. Connection URLs via env:
  ```sh
  export SRC_DB_URL='postgres://USER:PW@47.115.253.201:5432/postgres'
  export DST_DB_URL='postgres://USER:PW@<saas-mono-host>:5432/postgres'
  ```
- Confirmed: saas-mono is identical to 47.x (PG 18.3, age 1.6.0 / pgvector 0.8.1.2 /
  pg_cron / pg_net present), and `amux` does not yet exist on saas-mono.

## Run

```sh
./transplant-amux.sh dump-only   # inspect artifacts in ./_dump first (recommended)
./transplant-amux.sh             # preflight -> dump -> 3-phase load
```

The 3-phase load resolves the table⇄function⇄trigger dependency cycle:
1. `amux`+`app` **pre-data** (schemas, tables, functions)
2. teamclaw **public functions**
3. `amux`+`app` **post-data** (constraints, indexes, triggers, RLS policies)

`check_function_bodies` is off during phases 1–2 (late-bound plpgsql).

## Manual steps after the script (DB-side done, these are config/ops)

1. **GoTrue**: set the custom access-token hook → `public.amux_access_token_hook`
   (injects `app_metadata.org_id` + memberships + acl). Test one login.
2. **PostgREST**: add `amux` to `PGRST_DB_SCHEMAS` (keep `public`) + restart.
3. **Reconcile mirrors**: the 47.x `public.plans` (stub) and `public.users`
   (subset) were dev mirrors — on saas-mono use its **real** plans/users DDL.
   Ensure `public.users` has `auth_user_id`/`org_id` + the `uq_users_auth_user_id`
   unique index that `ensure_personal_org` / `claim_team_invite` rely on.
4. **JWT**: unify GoTrue `JWT_SECRET` so teamclaw FC tokens interoperate.
5. **FC**: point `SUPABASE_URL` at saas-mono. FC auto-deploys on PR merge
   (GHA on `services/fc/**`). FC already carries default schema=amux +
   `.schema('public').rpc(...)` + create_team(p_oid)/ensure_personal_org wiring.

## Acceptance (run on DST after everything)

```sql
-- structure
select count(*) from information_schema.tables  where table_schema='amux' and table_type='BASE TABLE';  -- 35
select count(*) from information_schema.views   where table_schema='amux' and table_name='actor_directory'; -- 1
select count(*) from information_schema.columns where table_schema='amux' and table_name='teams' and column_name='oid'; -- 1
select count(*) from pg_policies where schemaname='amux' and policyname='teams_org_guard'; -- 1
-- hook runs
select public.amux_access_token_hook('{"user_id":"00000000-0000-0000-0000-0000000000ff","claims":{}}'::jsonb) is not null;
```
Then smoke via FC: login (token carries `org_id`) → create team (teams.oid set) →
tenant isolation holds → claim an invite switches org.
