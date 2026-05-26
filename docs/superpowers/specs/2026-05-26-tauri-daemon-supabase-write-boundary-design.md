# Tauri and Daemon Supabase Write Boundary

**Date:** 2026-05-26
**Status:** Draft for review
**Base:** `agent/preview-integration` at `26d388a`
**Scope:** Tauri Desktop (`packages/app/` + `apps/desktop/`) and amux daemon (`apps/daemon/`)

## Summary

The previous phase introduced a Desktop backend facade and moved the core
auth/session/message/attachment paths behind it. This phase expands that rule
from the chat main path to the whole Tauri Desktop product surface and daemon
business logic.

The rule is:

> Any Tauri Desktop or daemon code that writes Supabase must either live inside
> a Supabase provider adapter or be explicitly classified as a provider-specific
> exception with a written reason.

This phase still does not implement PocketBase. It removes hidden Supabase write
dependencies so a later PocketBase provider can be implemented by filling domain
adapters, not by hunting writes across UI components and daemon workflows.

## Goals

- Inventory every Supabase write in `packages/app/`, `apps/desktop/`, and
  `apps/daemon/`.
- Move product-facing Desktop writes into `packages/app/src/lib/backend/`
  domain interfaces.
- Keep Supabase SDK and PostgREST/RPC details inside
  `packages/app/src/lib/backend/supabase/` for Desktop.
- Keep daemon remote writes inside `apps/daemon/src/supabase/` and make daemon
  business code speak in provider-neutral names where practical.
- Include visible secondary product surfaces: Ideas, actors, invites, session
  members, shortcuts, notification preferences, daemon workspace/admin, team
  config, and telemetry writes.
- Preserve current Supabase behavior and schema.

## Non-Goals

- No PocketBase adapter implementation.
- No Supabase schema, RLS, storage bucket, or RPC changes.
- No iOS, Android, or Expo migration.
- No rewrite of the Tauri Rust backend if it only stores server config or talks
  to local files/daemon/MQTT.
- No attempt to remove Supabase references from provider adapters, adapter
  tests, docs that explicitly describe Supabase, or self-host configuration UI.

## Current Inventory

### Desktop frontend direct writes

These are product or background writes outside the new backend facade:

- `stores/session-messages.ts`
  - `messages.insert`
- `stores/current-team.ts`
  - `rename_team` RPC
- `stores/telemetry.ts`
  - telemetry rows and report state writes
- `lib/daemon-workspaces.ts`
  - `update_agent_defaults` RPC
- `lib/team-workspace-config.ts`
  - `team_workspace_config.upsert`
- `lib/notifications/preferences.ts`
  - `notification_prefs.upsert`
  - `session_mutes.upsert/delete`
- `lib/idea-mutations.ts`
  - `update_idea` RPC
  - `create_idea_activity` RPC
- `lib/shortcuts-rpc.ts`
  - `shortcut_create` RPC
  - `shortcuts.update/delete`
  - `shortcut_batch_move` RPC
  - `shortcut_set_visible_roles` RPC
- `lib/daemon-agent-admin.ts`
  - `update_owned_agent_profile` RPC
- `lib/telemetry/supabase-feedback.ts`
  - `actor_message_feedback.insert`
- `lib/telemetry/supabase-session-report.ts`
  - `actor_session_report.insert`
- `components/auth/AuthGate.tsx`
  - `create_team` RPC
- `components/settings/team/TeamGitConfig.tsx`
  - create team git flow and `create_team_invite` RPC
- `components/chat/ActorChatInput.tsx`
  - `messages.insert`
- `components/chat/SessionActorSheet.tsx`
  - `session_participants.delete/insert`
  - runtime model update side effects
- `components/sidebar/InviteActorDialog.tsx`
  - `create_team_invite` RPC
- `components/sidebar/CreateIdeaDialog.tsx`
  - `create_idea` RPC
- `components/sidebar/IdeasSection.tsx`
  - `archive_idea` RPC
- `components/sidebar/ActorsSection.tsx`
  - `remove_team_actor` RPC

These writes should move behind domain methods. Read-only Supabase calls that
support these writes should move with them when keeping them separate would
leave a component half provider-bound.

### Desktop frontend direct reads

The scan also found direct reads in visible surfaces such as `App.tsx`,
`ChatPanel.tsx`, `MentionPopover.tsx`, `NewSessionDialog.tsx`,
`AgentSelectorDock.tsx`, `IdeasView.tsx`, `ActorsView.tsx`,
`SessionContinueBanner.tsx`, `current-actor.ts`, `session-by-actor.ts`, and
daemon workspace/runtime helpers.

Reads are not the primary acceptance gate for this phase, but a read should be
migrated when it is part of the same workflow as a migrated write, or when the
component would otherwise still import `@/lib/supabase-client`.

### Tauri Rust backend

The current `apps/desktop/src` scan does not show direct Supabase data writes.
It contains:

- server configuration fields such as `supabase_url` and `supabase_anon_key`
- comments that refer to Supabase-backed product state
- generic HTTP calls to non-Supabase services
- local file, secret, team, cron, and daemon RPC writes

Design decision: `apps/desktop` does not need a data-provider abstraction in
this phase. It should not gain one unless a real Supabase write appears. Server
config remains allowed to mention Supabase because Supabase is still a supported
provider.

### Daemon writes

Actual daemon remote writes are already concentrated in
`apps/daemon/src/supabase/client.rs` through `SupabaseBackend`, including:

- auth refresh and password login
- generic authenticated and anonymous RPC
- `claim_team_invite`
- `agent_runtimes` upsert and cursor/model PATCH
- `agents` device/default type PATCH
- `update_actor_last_active` RPC
- `workspaces` upsert
- `upsert_external_actor` RPC
- `ensure_gateway_session` RPC
- `messages` insert and gateway-message insert
- attachment upload
- `list_agent_admin_member_actor_ids` RPC plus participant upserts
- cron session creation

Those writes are allowed in the Supabase adapter.

Business logic still leaks Supabase naming and DTOs in:

- `daemon/server.rs`
- `runtime/manager.rs`
- `teamclaw/session_manager.rs`
- `channels/acp_handle.rs`
- `channels/supabase_store.rs`
- onboarding URL/config helpers

The immediate daemon goal is not to split the large Supabase adapter. It is to
make business-facing names provider-neutral and keep Supabase-only types at the
edge.

## Target Architecture

### Desktop backend facade

Extend `packages/app/src/lib/backend/types.ts` with domain services rather than
generic Supabase operations:

- `teams`
  - create team
  - rename team
  - create invite
  - remove actor
  - load current actor/team directory details needed by UI writes
- `ideas`
  - create idea
  - update idea
  - archive idea
  - create activity
  - list ideas/detail rows needed by visible idea pages
- `actors`
  - list actor directory
  - list connected agents
  - update owned agent profile
  - update agent defaults
- `sessionMembers`
  - list participants with actor rows
  - add/remove participants
  - list candidate actors
- `shortcuts`
  - create/update/delete
  - batch move
  - set visible roles
  - list shortcuts and roles needed by the same UI
- `notifications`
  - load/save notification preferences
  - mute/unmute sessions
- `teamWorkspaceConfig`
  - load/save workspace config
- `telemetry`
  - insert feedback
  - insert session report
  - any existing telemetry writes that currently go to Supabase

Each service maps the existing Supabase RPC/table shape in the Supabase adapter.
The UI should not import `@/lib/supabase-client` for these workflows.

### Desktop provider boundary rules

Allowed Supabase imports in `packages/app/src` after this phase:

- `packages/app/src/lib/supabase-client.ts`
- `packages/app/src/lib/backend/supabase/**`
- tests that explicitly exercise the Supabase adapter or legacy mocks
- self-host/server config UI that displays or stores Supabase connection fields

Disallowed:

- visible UI components importing `@/lib/supabase-client`
- stores/helpers writing through `supabase.from(...).insert/update/upsert/delete`
- stores/helpers writing through `supabase.rpc(...)`
- telemetry helpers writing directly to Supabase

### Daemon boundary rules

Allowed Supabase-specific code in daemon:

- `apps/daemon/src/supabase/**`
- daemon boot/onboarding config that explicitly constructs `SupabaseBackend`
  while Supabase is the only production provider
- tests whose purpose is Supabase adapter behavior

Business code should prefer:

- field names like `backend`, `backend_session_id`, `remote_session_id`,
  `remote_workspace_id`, `backend_runtime_row_id`
- method names like `insert_session_from_backend`
- comments that say "remote backend" unless the behavior is truly Supabase-only

Business code should not construct REST paths, RPC names, or Supabase DTOs. If a
business method currently accepts `SupabaseSessionRow` or
`SupabaseParticipantRow`, introduce provider-neutral DTOs in `backend` and let
the Supabase adapter map into them.

## Implementation Strategy

This work is too broad for one mechanical change. It should be implemented in
batches, each with failing tests first.

### Batch 1: write inventory guardrails

- Add a script or focused test that scans product source for disallowed
  Supabase imports/writes.
- Whitelist the adapter/config/test paths above.
- The first red test should fail on the current direct writes.
- This gives later batches a visible completion gate.

### Batch 2: Desktop collaboration surfaces

Migrate chat/session/actor writes and adjacent reads:

- `session-messages.ts`
- `ActorChatInput.tsx`
- `SessionActorSheet.tsx`
- `ChatPanel.tsx` write-adjacent reads
- `MentionPopover.tsx`
- `NewSessionDialog.tsx`
- `AgentSelectorDock.tsx`
- `InviteActorDialog.tsx`
- `ActorsSection.tsx`

### Batch 3: Ideas and team/product pages

Migrate visible secondary pages:

- `idea-mutations.ts`
- `IdeasView.tsx`
- `IdeasSection.tsx`
- `CreateIdeaDialog.tsx`
- `IdeaDetailDialog.tsx`
- `current-team.ts`
- `AuthGate.tsx`
- `TeamGitConfig.tsx` writes that create teams/invites

### Batch 4: utilities and background writes

Migrate:

- `shortcuts-rpc.ts`
- `notifications/preferences.ts`
- `team-workspace-config.ts`
- `daemon-workspaces.ts`
- `daemon-agent-admin.ts`
- telemetry writes

Telemetry can map to a `telemetry` backend service whose non-Supabase
implementation may no-op later. It should still stop importing Supabase
directly from UI/background code.

### Batch 5: daemon business naming and DTO boundary

- Rename business fields/variables from `supabase` to `backend` where they
  refer to `Arc<dyn Backend>`.
- Rename runtime/session metadata fields where doing so is contained and
  testable.
- Introduce provider-neutral session/participant/message DTO aliases or structs
  in `apps/daemon/src/backend/`.
- Keep `apps/daemon/src/supabase/client.rs` as the only production remote-write
  implementation.
- Keep onboarding config Supabase-specific until a second daemon provider
  exists.

## Error Handling

Desktop adapter methods should throw `BackendError` with an operation name and
category. UI code should keep its current behavior: show existing messages, log
warnings for best-effort background writes, and avoid changing UX copy unless a
message explicitly names Supabase today.

Daemon business code should handle `BackendResult<T>` only. Supabase errors may
be logged as provider details at the adapter edge, but business methods should
not pattern-match on `SupabaseError`.

## Testing

Required test styles:

- Contract tests for each new backend service method.
- Component/store tests that mock `@/lib/backend`, not `@/lib/supabase-client`.
- A source-scan test for disallowed Supabase writes/imports in product code.
- Existing targeted tests for migrated components.
- Daemon tests proving business code works through `MockBackend` and no longer
  requires Supabase DTOs where migrated.

Expected verification commands:

```bash
pnpm --filter @teamclaw/app exec vitest run \
  src/lib/backend \
  src/lib/__tests__ \
  src/stores \
  src/components/chat \
  src/components/sidebar \
  src/components/panel

pnpm --filter @teamclaw/app typecheck
cargo test -p amuxd backend
cargo test -p amuxd
```

The exact test subset may be narrowed in the implementation plan per batch, but
the final gate must include source-scan, typecheck, and daemon tests.

## Acceptance Criteria

- Every Supabase write in Tauri Desktop and daemon is classified.
- Product code in `packages/app/src` has no direct Supabase writes outside the
  allowed adapter/config/test paths.
- Visible Desktop pages for chat, sessions, actors, ideas, shortcuts,
  notifications, daemon workspace/admin, and team settings write through the
  backend facade.
- `apps/desktop/src` has no direct Supabase data writes; if this remains true,
  the spec records it and no Rust desktop provider abstraction is added.
- Daemon business logic no longer uses Supabase-specific result/error types.
- Daemon remote writes remain concentrated in `apps/daemon/src/supabase/`.
- Existing Supabase behavior is preserved.

## Open Implementation Notes

- Some existing files combine reads and writes. Prefer migrating the whole
  workflow in one batch when splitting would leave confusing mixed provider
  dependencies.
- Large UI components such as `SessionActorSheet.tsx` and `ChatPanel.tsx`
  should be changed surgically. Extract backend calls into small helpers only
  when it reduces test complexity.
- Do not change Supabase database functions during this phase. Adapter methods
  call existing RPC names.
- Do not start a PocketBase schema until this write boundary is clean.
