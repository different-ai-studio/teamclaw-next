# Backend Provider Boundary for Future PocketBase Support

**Date:** 2026-05-25
**Status:** Approved (pending implementation plan)
**Scope:** TeamClaw Desktop web app (`packages/app/`) and amux daemon (`apps/daemon/`)

## Overview

TeamClaw v2 currently treats Supabase as the authority for auth, teams, actors,
sessions, messages, runtime cursors, invites, and attachments. The product goal
is to keep Supabase available while making the backend replaceable, with
PocketBase as a planned alternative.

This design adds a TeamClaw-owned backend provider boundary before introducing
PocketBase. The first implementation keeps the existing Supabase behavior. The
important change is where Supabase is allowed to appear: inside an adapter, not
in UI stores, desktop feature helpers, or daemon business logic.

## Goals

- Let Desktop and daemon main collaboration flows depend on TeamClaw domain
  interfaces instead of Supabase SDK, PostgREST, SQL RPC, or Supabase Storage
  shapes.
- Preserve current Supabase production behavior in this phase.
- Keep PocketBase in mind as the second provider without leaking PocketBase
  collection, rule, hook, or SSE details into callers.
- Make later provider work incremental: implement a new adapter and run the
  same contract tests instead of rewriting UI stores again.
- Keep Supabase migrations and pgTAP tests as the Supabase adapter's schema
  contract.

## Non-Goals

- No PocketBase adapter implementation in this phase.
- No Supabase schema, RLS, storage bucket, or RPC changes.
- No mobile rewrite. iOS, Android, and Expo keep their current Supabase
  integrations.
- No migration of telemetry, shortcuts, ideas, team git config, or other
  secondary surfaces unless they block the Desktop + daemon main path.
- No replacement of MQTT. Session live transport remains provider-independent
  and continues to use EMQX/MQTT.

## Background

`docs/architecture/v2.md` already defines the long-term direction: Supabase
should become one official backend provider rather than the architecture center.
It recommends a provider boundary before adding alternatives such as local
SQLite, TrailBase, PocketBase, or plain Postgres.

The current code is mixed:

- `apps/daemon/src/backend/mod.rs` already has a `Backend` trait and mock
  implementation, but many names and types still carry Supabase assumptions.
- `packages/app/src/lib/supabase-client.ts` exposes a global Supabase client,
  and stores/components call `.from(...)`, `.rpc(...)`, `.auth`, and `.storage`
  directly.
- Desktop has a local libsql cache for fast reads, but the cache sync helpers
  still pull directly from Supabase.
- Realtime session events are already mostly independent of Supabase because
  live traffic uses MQTT.

PocketBase is a good forcing function because it does not look like Supabase.
It uses an embedded SQLite database, auth collections, collection-level API
rules, REST-ish record APIs, file fields, and SSE-based realtime. It can also be
extended with custom Go or JavaScript routes. The provider contract must
therefore describe TeamClaw actions, not database primitives.

References:

- PocketBase docs: https://pocketbase.io/docs/
- Records API: https://pocketbase.io/docs/api-records/
- Realtime API: https://pocketbase.io/docs/api-realtime/
- API rules: https://pocketbase.io/docs/api-rules-and-filters/
- Authentication: https://pocketbase.io/docs/authentication/
- Go routing extensions: https://pocketbase.io/docs/go-routing/

## Design Principles

1. **Domain API first.** Callers ask for TeamClaw operations such as
   `listSessions`, `insertOutgoingMessage`, or `claimInvite`. They do not build
   Supabase filters or PocketBase filter strings.
2. **Provider-neutral errors.** UI and daemon handle `BackendError`, not
   Supabase errors. Adapters preserve useful details for logging.
3. **Transport stays separate.** MQTT remains the live session transport.
   Backend providers own authority, persistence, permissions, compensating
   reads, cursor state, and attachment metadata.
4. **No lowest-common-denominator query builder.** The facade is not a generic
   ORM. It is a small set of use-case methods.
5. **Supabase remains the first adapter.** Phase 1 moves boundaries without
   changing data shape or runtime behavior.

## Provider Shape

### Desktop TypeScript boundary

Add `packages/app/src/lib/backend/`.

```text
packages/app/src/lib/backend/
  index.ts
  types.ts
  errors.ts
  provider.ts
  supabase/
    client.ts
    auth.ts
    directory.ts
    sessions.ts
    messages.ts
    runtime.ts
    attachments.ts
```

The public facade exports a singleton for the selected provider:

```ts
export interface TeamClawBackend {
  kind: "supabase" | "pocketbase" | "local";
  auth: AuthBackend;
  directory: DirectoryBackend;
  sessions: SessionsBackend;
  messages: MessagesBackend;
  runtime: RuntimeBackend;
  attachments: AttachmentsBackend;
}
```

Phase 1 selection always resolves to Supabase, using existing server config:

- injected `window.__TEAMCLAW_SERVER_CONFIG__`
- saved `teamclaw.serverConfig`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Future config adds `backendProvider` and provider-specific settings, but Phase
1 does not expose a PocketBase UI option because it would not work yet.

### Desktop interfaces

`AuthBackend`

- `getSession(): Promise<AuthSession | null>`
- `onAuthStateChange(listener): Unsubscribe`
- `sendOtp(email): Promise<void>`
- `verifyOtp(email, code): Promise<AuthSession>`
- `signInAnonymously(): Promise<AuthSession>`
- `signOut(): Promise<void>`
- `claimInvite(token): Promise<AuthClaimResult>`

`DirectoryBackend`

- `resolveCurrentMemberActor(teamId, userId): Promise<ActorRef | null>`
- `listActorDirectory(teamId, opts): Promise<ActorDirectoryEntry[]>`
- `listTeamMembers(teamId): Promise<TeamMember[]>`
- `listConnectedAgents(teamId): Promise<ConnectedAgent[]>`
- `listAgentAccess(agentId): Promise<AgentAccessRow[]>`
- `upsertAgentAccess(input): Promise<void>`
- `removeAgentAccess(accessId): Promise<void>`

`SessionsBackend`

- `listCurrentActorSessions(page): Promise<SessionListPage>`
- `markCurrentActorSessionViewed(sessionId, lastReadMessageId): Promise<void>`
- `createSessionShell(input): Promise<{ sessionId: string }>`
- `addParticipants(sessionId, actorIds): Promise<void>`
- `updateSessionTitle(sessionId, title): Promise<void>`
- `archiveSession(sessionId): Promise<void>`
- `getSessionParticipants(sessionId): Promise<SessionParticipant[]>`

`MessagesBackend`

- `listMessages(sessionId, page): Promise<MessageHistoryPage>`
- `insertOutgoingMessage(input): Promise<void>`
- `updateMessageContent(messageId, content): Promise<void>`
- `insertGatewayMessage(input): Promise<{ messageId: string }>`

`RuntimeBackend`

- `listAgentRuntimes(teamId, opts): Promise<AgentRuntime[]>`
- `findLatestRuntimeForAgent(teamId, agentId): Promise<AgentRuntime | null>`
- `updateRuntimeModel(runtimeId, model): Promise<void>`
- `updateRuntimeCursor(runtimeRowId, lastProcessedMessageId): Promise<void>`
- `upsertAgentRuntime(input): Promise<{ rowId?: string }>`

`AttachmentsBackend`

- `uploadAttachment(input): Promise<AttachmentRef>`
- `createReadableUrl(ref, opts): Promise<string>`

The interfaces intentionally do not expose `from`, `select`, `rpc`, SQL
function names, PocketBase collection names, or PocketBase filter syntax.

### Daemon Rust boundary

The daemon already has a usable starting point in `apps/daemon/src/backend/`.
Phase 1 keeps the trait-object call pattern but neutralizes naming and error
types.

Target structure:

```text
apps/daemon/src/backend/
  mod.rs
  error.rs
  auth.rs
  directory.rs
  sessions.rs
  messages.rs
  runtime.rs
  attachments.rs
  mock.rs
apps/daemon/src/providers/supabase/
  mod.rs
  client.rs
  config.rs
```

The existing `SupabaseBackend` remains the only production implementation. The
trait names and data transfer objects become provider-neutral:

- `BackendError` replaces direct `SupabaseError` in trait signatures.
- `StoredMessage`, `WorkspaceRow`, `AgentRuntimeRow`, and similar DTOs are
  reviewed for Supabase-specific naming.
- Credential methods become `auth_token` / `cached_credential_expiry`, not
  Supabase session methods.
- Generic `rpc` helpers stay private to the Supabase adapter.

## Main Data Flows

### Desktop cold start

```text
AuthGate / auth-store
  -> backend.auth.getSession()
  -> backend.auth.onAuthStateChange(...)
  -> current-team store resolves team state through backend.directory
  -> session-list-store calls backend.sessions.listCurrentActorSessions(...)
```

Current behavior remains Supabase-backed. The UI stops importing
`supabase-client` directly for this path.

### Session list and local cache hydrate

```text
session-list-store
  -> local libsql hydrate, if Tauri and last team id exists
  -> backend.sessions.listCurrentActorSessions(page)
  -> upsert local libsql rows
  -> render
```

The cache remains provider-agnostic. Cache sync helpers should receive a
provider method or backend dependency instead of calling Supabase directly.

### Create session with first message

```text
NewSessionDialog / ChatPanel
  -> backend.sessions.createSessionShell(...)
  -> backend.messages.insertOutgoingMessage(...)
  -> mqttPublish(message.created envelope)
  -> startAgentRuntimesAsync(...)
```

Agent runtime startup still uses MQTT RPC. Provider calls only persist authority
state and read runtime metadata.

### Daemon runtime resume and message persistence

```text
amuxd
  -> backend.fetch_session_with_participants(...)
  -> backend.messages_after_cursor(...)
  -> ACP runtime
  -> MQTT stream events
  -> backend.insert_message(...) for completed replies
  -> backend.update_runtime_cursor(...)
```

This is the key daemon path to preserve. It already mostly uses `Arc<dyn
Backend>`; the work is to remove Supabase-specific assumptions from the trait
surface.

### Attachments

```text
Desktop / daemon
  -> backend.attachments.uploadAttachment(...)
  -> AttachmentRef stored in message metadata or attachments field
  -> backend.attachments.createReadableUrl(...)
```

Supabase adapter uses Storage. A future PocketBase adapter can use file fields
or a custom collection/route, but callers only see `AttachmentRef`.

## Error Handling

`BackendError` has stable categories:

- `Unauthenticated`
- `Forbidden`
- `NotFound`
- `Conflict`
- `Validation`
- `Unavailable`
- `Timeout`
- `RateLimited`
- `Provider`
- `Unknown`

Each error carries:

- user-safe `message`
- optional provider `kind`
- optional `operation`
- optional diagnostic `cause` for logs

Stores should set user-visible state from the stable category and message. Debug
logging can include provider detail, but UI strings should not mention
Supabase-specific or PocketBase-specific mechanics unless the failing provider
is user-configured and the detail is actionable.

## Testing

### Contract tests

Add provider contract tests that exercise the domain interfaces with a fake or
mock adapter:

- auth hydrate and auth-state change
- claim invite success and failure
- list sessions pagination and unread marker behavior
- create session shell with participants
- insert outgoing message with metadata and attachments
- mark session viewed
- update title / archive
- list runtime metadata and update runtime cursor
- upload attachment returns stable `AttachmentRef`

These tests must not assert Supabase query-builder call chains. They assert
TeamClaw behavior and adapter inputs/outputs.

### Supabase adapter tests

Keep existing Supabase mocks where useful, but move new tests to the adapter
level. Supabase pgTAP tests and migrations under `services/supabase/` remain
the source of truth for live schema behavior.

### Daemon tests

Keep `MockBackend`, but update it to implement the neutral traits. Existing
runtime/session tests should continue to run against the mock without importing
Supabase modules except for adapter-specific tests.

## Migration Plan

This plan is intentionally boundary-first and behavior-preserving.

1. Add Desktop backend types, error type, provider factory, and Supabase adapter.
2. Move `auth-store` from direct `supabase.auth` / `supabase.rpc` usage to
   `backend.auth`.
3. Move `session-list-store` to `backend.sessions`, including list pagination,
   mark viewed, title update, and archive.
4. Move `session-create`, `outbox-sender`, and message history paths to
   `backend.messages` and `backend.sessions`.
5. Move attachment upload to `backend.attachments`.
6. Move runtime metadata lookups and model/cursor updates to `backend.runtime`.
7. Update local cache sync helpers so their remote reads come through the
   backend facade or a small sync-specific domain method.
8. Neutralize daemon backend trait names and error types while keeping the
   existing Supabase implementation.
9. Add contract tests and update existing mocks.
10. Leave secondary Supabase imports in telemetry, shortcuts, ideas, and team
    settings with a tracking note unless they block the main path.

## Future PocketBase Adapter Notes

PocketBase should be implemented after the boundary is in place.

Expected mapping:

- Auth: TeamClaw users map to a PocketBase auth collection.
- Teams/actors/sessions/messages: map to collections with API rules that encode
  TeamClaw membership and participant checks.
- SQL RPC equivalents: use custom Go or JavaScript routes/hooks where a single
  operation needs server-side authority or transaction-like behavior.
- Realtime: PocketBase SSE can be useful for administrative record changes, but
  session live traffic remains MQTT.
- Attachments: use PocketBase file fields or custom routes, normalized into
  `AttachmentRef`.

Key constraint: PocketBase collection names, filter strings, and hook choices are
adapter internals. If the TeamClaw interface starts to expose them, the boundary
has failed.

## Acceptance Criteria

- Desktop main session flow compiles and passes existing tests with Supabase as
  the only active provider.
- New or migrated Desktop main-flow code imports from `@/lib/backend`, not
  `@/lib/supabase-client`.
- Daemon runtime/session code depends on provider-neutral backend traits and
  `BackendError`, with Supabase code isolated to the Supabase provider module.
- No Supabase schema or live database changes are required.
- Existing MQTT behavior is unchanged.
- A future PocketBase adapter can be scoped as adapter work plus provider
  contract tests, without rewriting Desktop stores again.

## Open Follow-Up

After this spec is accepted, the implementation plan should break the work into
small commits by caller path. The first useful PR can stop after auth +
session-list facade migration if it leaves the old Supabase client available for
unmigrated surfaces.
