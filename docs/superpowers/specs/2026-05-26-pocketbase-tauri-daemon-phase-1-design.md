# PocketBase Tauri + Daemon Phase 1

**Date:** 2026-05-26
**Status:** Implementation basis
**Base:** `main` at `69b4a741`
**Scope:** Tauri Desktop (`packages/app/` + `apps/desktop/`), amux daemon (`apps/daemon/`), PocketBase service config, and EMQX HTTP auth integration

## Summary

Phase 1 should prove the core collaboration loop on PocketBase without trying
to replace every Supabase-backed product surface.

The success path is:

```text
Tauri signs in to PocketBase
  -> resolves current team/member actor
  -> creates a session and sends a user message
  -> publishes the live envelope through EMQX/MQTT
  -> daemon receives the live envelope
  -> daemon starts or resumes a runtime
  -> daemon writes the agent reply to PocketBase
  -> Tauri reloads or live-applies the reply
```

MQTT remains the realtime transport. PocketBase is the authority for auth,
teams, actors, sessions, messages, daemon runtime rows, and workspace rows. EMQX
authn/authz is provided by a small PocketBase-aware HTTP service instead of by
Supabase JWT/RLS assumptions.

## Latest Code Facts

The latest `main` materially changes the migration risk:

- Desktop product code is already behind a broad `TeamClawBackend` facade.
  `BackendKind` includes `"pocketbase"`, but the provider factory still always
  constructs Supabase.
- Daemon business logic already binds to `Arc<dyn Backend>`, but daemon startup
  and onboarding still construct `SupabaseBackend` directly from
  `supabase.toml`.
- Tauri Rust does not write Supabase data directly. It stores server config,
  local files, daemon/MQTT commands, and local cache state.
- Desktop and daemon MQTT clients now both raise the rumqttc packet cap to 4
  MiB, so large ACP/live payload support is explicit on both sides.
- The provider-boundary guardrail test passes on this base, so the first
  PocketBase work should extend the existing boundary instead of creating a new
  parallel data path.

## Goals

- Add PocketBase as a selectable provider for Tauri Desktop and daemon.
- Keep Supabase as the default and preserve existing Supabase behavior.
- Implement the minimum PocketBase collection set required by the main chat
  session flow.
- Implement EMQX HTTP authn/authz backed by PocketBase records.
- Keep MQTT topic names and protobuf live envelopes unchanged.
- Use a current-schema PocketBase projection. Do not replay or emulate every
  historical Supabase migration.
- Make unsupported PocketBase surfaces fail with explicit provider errors
  rather than silently falling back to Supabase.

## Non-Goals

- No iOS, Android, or Expo PocketBase support in this phase.
- No PocketBase realtime usage for live chat.
- No full Supabase RLS parity in PocketBase rules.
- No production cutover or data migration of all existing customer data.
- No full support for shortcuts, telemetry, notification preferences, and ideas
  unless one of those paths blocks the Tauri + daemon smoke test.
- No broker ACL changes to the MQTT topic schema.

## Architecture

```text
packages/app
  TeamClawBackend facade
    supabase adapter      existing
    pocketbase adapter    new phase-1 implementation

apps/desktop
  ServerConfig
    backendKind
    supabase settings
    pocketbase settings
    MQTT settings

apps/daemon
  Backend trait
    SupabaseBackend       existing
    PocketBaseBackend     new phase-1 implementation

services/pocketbase
  PocketBase collections, rules, hooks/routes, seed fixtures

services/emqx-auth
  HTTP authn/authz service or PocketBase custom routes used by EMQX

EMQX
  MQTT transport and topic ACL enforcement
```

The implementation should prefer provider-specific adapters at the edge and
TeamClaw domain methods in callers. Do not introduce a generic query-builder
abstraction.

## Desktop Provider Selection

Extend `ServerConfig` with:

```ts
export interface ServerConfig {
  backendKind?: "supabase" | "pocketbase";
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  pocketbaseUrl?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUseTls?: boolean;
}
```

Selection rules:

- Missing `backendKind` means `"supabase"` for backward compatibility.
- `"supabase"` requires the existing Supabase config.
- `"pocketbase"` requires `pocketbaseUrl`.
- `getBackend()` constructs one singleton per effective provider config.
- Switching provider through settings resets the backend singleton and forces a
  fresh auth/session load.

Create:

```text
packages/app/src/lib/backend/pocketbase/
  client.ts
  config.ts
  auth.ts
  directory.ts
  teams.ts
  actors.ts
  sessions.ts
  session-members.ts
  messages.ts
  runtime.ts
  workspaces.ts
  unsupported.ts
  index.ts
```

Phase-1 supported Desktop services:

- `auth`
- `directory`
- `teams`
- `actors`
- `sessions`
- `sessionMembers`
- `messages`
- `runtime`
- `workspaces`
- `sync` for actors, session participants, messages, and sessions if the local
  cache path is active during smoke testing

Phase-1 unsupported Desktop services return `BackendError` with category
`unsupported` and a message naming the provider and service:

- `attachments`
- `ideas`
- `shortcuts`
- `notifications`
- `teamWorkspaceConfig`
- `telemetry`

Attachments stay unsupported because the main smoke test is text-only and live
payload capacity has just been fixed in MQTT. This keeps the first provider
small.

## Daemon Provider Selection

The daemon should stop treating `supabase.toml` as the only boot credential.
Introduce a provider config loader with this backward-compatible behavior:

- If `~/.amuxd/backend.toml` exists, read it.
- Else if `~/.amuxd/supabase.toml` exists, load Supabase exactly as today.
- Else fail with a message that names both supported setup paths.

Recommended `backend.toml` shape:

```toml
kind = "pocketbase"

[pocketbase]
url = "http://127.0.0.1:8090"
refresh_token = "..."
team_id = "team-id"
actor_id = "agent-actor-id"
```

Supabase may also be represented in `backend.toml`, but Phase 1 does not need
to migrate existing `supabase.toml` files.

Create:

```text
apps/daemon/src/provider_config.rs
apps/daemon/src/pocketbase/
  mod.rs
  client.rs
  config.rs
  records.rs
  error.rs
```

`PocketBaseBackend` implements the existing `Backend` trait. It should preserve
the current daemon call pattern:

- `team_id()`
- `actor_id()`
- `auth_token()`
- `cached_credential_expiry()`
- `upsert_agent_runtime()`
- `fetch_agent_runtime_for_session()`
- `fetch_latest_runtime_for_session()`
- `ensure_agent_types()`
- `set_agent_device_id()`
- `check_agent_permission()`
- `heartbeat()`
- `upsert_workspace()`
- `fetch_session_with_participants()`
- `messages_after_cursor()`
- `update_runtime_cursor()`
- `rpc_upsert_external_actor()`
- `get_gateway_session_by_acp_id()`
- `rpc_ensure_gateway_session()`
- `insert_gateway_message()`
- `insert_gateway_message_with_attachments()`
- `list_agent_admin_member_actor_ids()`
- `upsert_session_participant()`
- `create_cron_session()`
- `insert_message()`

`upload_attachment_bytes()` may return an explicit unsupported backend error in
Phase 1 unless a touched gateway path requires attachments for the smoke test.

## PocketBase Current-Schema Projection

Use PocketBase collections that match the current TeamClaw domain, not the
full Supabase migration history.

Collections:

```text
accounts             auth collection for members and daemon agents
teams
actors
team_members
agent_member_access
team_invites
sessions
session_participants
messages
agent_runtimes
workspaces
external_actor_keys
```

Important fields:

- `actors`: `team`, `account`, `actor_type`, `display_name`,
  `last_active_at`, `source`, `source_id`, `agent_types`,
  `default_agent_type`, `default_workspace`
- `team_members`: `team`, `actor`, `role`, `status`, `joined_at`
- `agent_member_access`: `team`, `agent_actor`, `member_actor`,
  `permission_level`, `granted_by_member_actor`
- `team_invites`: `team`, `token_hash`, `actor_type`, `display_name`,
  `team_role`, `agent_kind`, `target_actor`, `expires_at`, `claimed_at`
- `sessions`: `team`, `title`, `mode`, `primary_agent`, `created_by_actor`,
  `idea_id`, `summary`, `acp_session_id`, `binding`, `last_message_preview`,
  `last_message_at`, `archived_at`
- `session_participants`: `team`, `session`, `actor`, `role`, `joined_at`
- `messages`: `team`, `session`, `sender_actor`, `kind`, `content`,
  `metadata`, `model`, `turn_id`, `reply_to_message`, `external_id`,
  `attachments`, `created_at`, `updated_at`
- `agent_runtimes`: `team`, `agent`, `session`, `workspace`, `backend_type`,
  `backend_session_id`, `runtime_id`, `status`, `current_model`,
  `last_processed_message`, `last_seen_at`
- `workspaces`: `team`, `agent`, `name`, `path`, `metadata`, `archived_at`
- `external_actor_keys`: `team`, `source`, `source_id`, `actor`

Required uniqueness:

- one `team_members` row per `(team, actor)`
- one `session_participants` row per `(session, actor)`
- one `agent_member_access` row per `(agent_actor, member_actor)`
- one `agent_runtimes` row per `(agent, backend_session_id)`
- one `messages` row per `(session, external_id)` when `external_id` is set
- one `external_actor_keys` row per `(team, source, source_id)`

PocketBase hooks/routes should implement operations that are currently Supabase
RPCs:

- claim team invite
- create team invite
- create team
- remove team actor
- check agent permission
- update actor last active
- upsert external actor
- ensure gateway session
- list agent admin member actor ids
- create cron session

These routes should return TeamClaw-shaped DTOs so the adapters stay thin.

## EMQX Auth Service

Use EMQX HTTP authentication and authorization. The service can be a small
standalone process or PocketBase custom routes. Co-locating it with PocketBase
is preferred for Phase 1 because token validation and ACL reads can use
server-side PocketBase APIs.

Authn endpoint behavior:

```text
Input:
  username = actor_id
  password = PocketBase auth token
  clientid = MQTT client id

Decision:
  token must authenticate an account
  actor_id must belong to that account
  actor must be active in at least one team

Output:
  allow with actor/team claims, or deny
```

Authz endpoint behavior:

```text
Input:
  actor_id
  clientid
  action = publish | subscribe
  topic

Decision:
  derive team_id from topic
  verify actor is a member or agent in that team
  apply topic-specific rules
```

Topic rules:

```text
members:
  subscribe inbox/{actor_id}
  subscribe amux/{team_id}/session/+/live
  publish   amux/{team_id}/session/{session_id}/live
  subscribe amux/{team_id}/device/+/state
  subscribe amux/{team_id}/device/+/runtime/+/state
  subscribe amux/{team_id}/device/+/rpc/res
  publish   amux/{team_id}/device/{device_id}/rpc/req

agents:
  subscribe amux/{team_id}/session/+/live
  publish   amux/{team_id}/session/{session_id}/live
  publish   amux/{team_id}/device/{own_device_id}/state
  publish   amux/{team_id}/device/{own_device_id}/runtime/{runtime_id}/state
  subscribe amux/{team_id}/device/{own_device_id}/runtime/+/commands
  subscribe amux/{team_id}/device/{own_device_id}/rpc/req
  publish   amux/{team_id}/device/{own_device_id}/rpc/res
```

For Phase 1, daemon `own_device_id` may equal the daemon actor id, matching the
current onboarding default. If the user preserves an old daemon device id, the
auth service must read the allowed device id from the daemon config record or
reject the connection with a clear log entry.

The auth service must not trust a decoded token alone. It must validate the
token against PocketBase server-side auth state or a verified PocketBase JWT
secret and then read actor/team permission records.

## Tauri Smoke Test Path

The smoke test should use only text messages and a single team:

1. Start PocketBase with Phase-1 collections and seed data.
2. Start EMQX with HTTP authn/authz pointing at the auth service.
3. Start the auth service.
4. Configure Desktop with `backendKind = "pocketbase"`, `pocketbaseUrl`, and
   MQTT host/port.
5. Sign in to PocketBase as a member account.
6. Confirm the first team and current member actor resolve.
7. Create a session with one daemon agent participant.
8. Send a user message.
9. Confirm Desktop publishes `amux/{team}/session/{session}/live`.
10. Start `amuxd` with PocketBase provider config.
11. Confirm daemon connects to MQTT with PocketBase token.
12. Confirm daemon reads the session, starts or resumes runtime state, writes an
    agent reply to `messages`, and updates `agent_runtimes`.
13. Confirm Desktop shows the agent reply after live event or reload.

## Testing Strategy

Guardrails:

- Keep the existing Supabase boundary test passing.
- Add a provider factory test for Supabase default and PocketBase selection.
- Add a Desktop server-config test for `backendKind` and `pocketbaseUrl`
  persistence.
- Add PocketBase adapter unit tests with mocked `fetch`.
- Add daemon provider-config tests for legacy `supabase.toml` fallback and
  `backend.toml` PocketBase selection.
- Add daemon `PocketBaseBackend` HTTP tests with a mock server.
- Add EMQX auth service tests for the member and agent topic rules above.

Manual acceptance:

- Run Tauri Desktop against PocketBase and EMQX.
- Run daemon against PocketBase.
- Complete the smoke test path without Supabase network calls.

## Execution Order

1. Add provider config shape and selection tests in Desktop.
2. Add Desktop PocketBase adapter shell with supported and unsupported service
   boundaries.
3. Add PocketBase collection and seed fixtures.
4. Add daemon provider-config loader.
5. Add daemon `PocketBaseBackend` for the core trait methods.
6. Add EMQX auth service.
7. Run local smoke test and tighten unsupported surfaces that block the path.

## Risks

- The `TeamClawBackend` interface is broad. Calling an unsupported secondary
  service during app boot will break the smoke test. The implementation should
  hide or short-circuit those surfaces for PocketBase until implemented.
- Daemon onboarding is currently Supabase-specific. It needs a provider-aware
  claim flow before PocketBase can be a clean first-run path.
- PocketBase rules are not Supabase RLS. Sensitive operations should live in
  server-side hooks/routes rather than trusting client-side collection writes.
- MQTT ACLs must match the current topic schema exactly. A too-strict ACL will
  look like a realtime bug even when PocketBase persistence is correct.
- Current-schema migration avoids historical migration complexity, but it still
  requires deliberate id mapping for teams, actors, sessions, and messages.
