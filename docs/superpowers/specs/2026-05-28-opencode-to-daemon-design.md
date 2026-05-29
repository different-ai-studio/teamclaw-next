# OpenCode Control Plane → Daemon Migration Design

**Date**: 2026-05-28
**Status**: Spec
**Scope**: Migrate all desktop- and app-facing OpenCode control-plane responsibilities into `apps/daemon/`, while keeping OpenCode as a daemon-managed ACP backend binary. After migration, desktop and app no longer start OpenCode directly, no longer talk to OpenCode's HTTP API directly, and no longer treat `opencode.json` or `.opencode/` as frontend-owned configuration surfaces.

---

## Goals

1. `apps/daemon/` becomes the single runtime and control-plane owner for OpenCode-backed agent execution.
2. `packages/app/` consumes only TeamClaw-owned HTTP/SSE APIs for sessions, runtime state, provider management, MCP, skills, roles, and permissions.
3. `apps/desktop/` stops managing OpenCode sidecar lifecycle and stops exposing OpenCode-specific Tauri IPC commands to the frontend.
4. Existing workspaces remain usable without one-shot migration by preserving daemon-side compatibility with `opencode.json`, `.opencode/`, and OpenCode's permission DB.
5. OpenCode remains replaceable as an internal backend implementation rather than a public API contract.

## Non-goals

- **Removing OpenCode as a backend binary**. OpenCode stays as the daemon-managed `AgentType::Opencode` ACP backend.
- **Redesigning the chat UX**. This spec changes backend/control-plane boundaries, not message rendering or Editorial Calm UI rules.
- **Replacing on-disk OpenCode workspace formats immediately**. `opencode.json` and `.opencode/` remain as compatibility storage in the near term.
- **Changing Cloud API/Supabase business-data boundaries**. This migration is about local runtime/control surfaces, not replacing the Cloud API contract for team/session/message business entities.
- **Introducing a new remote daemon control topology**. The scope is local desktop/app to local daemon, not multi-device daemon federation.

## Decisions

- **Daemon is the only public runtime/control endpoint**. Desktop and app call daemon-owned APIs only.
- **OpenCode becomes internal infrastructure**. It is launched, configured, and supervised only by daemon.
- **TeamClaw defines the public wire vocabulary**. Public HTTP/SSE payloads use TeamClaw-owned session and event schemas rather than OpenCode SDK shapes.
- **Compatibility is retained only below the daemon boundary**. The daemon may continue reading/writing OpenCode files; the frontend must not.
- **Migration lands in phases**. The target architecture is "full control-plane rebuild", but rollout should be staged to reduce regressions.

---

## Current State

The current OpenCode integration is split across three layers.

### Desktop owns OpenCode lifecycle and config mutation

`apps/desktop/src/commands/opencode.rs` currently acts as the OpenCode control plane. It owns:

- `start_opencode` / `stop_opencode`
- per-workspace process tracking via `OpenCodeState`
- startup preloading and `opencode_bootstrapped` events
- `opencode.json` mutation for permissions, plugin config, skill paths, provider.team sync, binary-path rewriting, and secret substitution
- inherent skill installation into `.opencode/skills`
- allowlist DB reads/writes and project-id lookups

`apps/desktop/src/commands/mcp.rs` also treats `opencode.json` as a desktop-owned config file.

### App talks to OpenCode directly

`packages/app/` currently uses OpenCode both as runtime API and settings API:

- `src/lib/opencode/preloader.ts` invokes `start_opencode`
- `src/lib/opencode/sdk-client.ts` wraps `@opencode-ai/sdk`
- `src/components/settings/LLMSection.tsx` connects straight to `http://127.0.0.1:13141`
- settings pages directly read/write `opencode.json` and call `restartOpencode()`
- multiple settings/store flows assume `.opencode/skills`, `.opencode/roles`, and OpenCode provider state are the source of truth

### Daemon already has the backend skeleton

`apps/daemon/` already has the beginnings of the desired boundary:

- `runtime/manager.rs` can spawn `AgentType::Opencode`
- `daemon/server.rs` can register `[agents.opencode]` as a launch config
- `http/routes.rs` and `http/sessions.rs` define TeamClaw-owned `/v1/sessions/*` endpoints
- `http/events.rs` defines a TeamClaw event vocabulary

However, the HTTP runtime layer is still partial: `http/runtime_adapter.rs` is still framed around a stub/dev adapter instead of being the universal frontend-facing runtime plane.

---

## Target Architecture

After migration, responsibility is split as follows.

### Daemon

`apps/daemon/` becomes the single owner of:

- OpenCode backend process supervision
- workspace runtime readiness and health
- session creation, prompt submission, streaming, cancellation, model changes, permission replies, and runtime restart
- workspace-scoped provider, MCP, skill, role, and permission management
- compatibility translation to and from `opencode.json`, `.opencode/`, and the OpenCode permission DB
- deciding whether a config change can be hot-reloaded or requires runtime restart

### Desktop

`apps/desktop/` becomes a shell for local integration only:

- install, start, and probe daemon
- provide minimal IPC for daemon connection/bootstrap if needed by the native shell
- stop exposing OpenCode-specific process/config commands to the frontend

Desktop is no longer the owner of OpenCode lifecycle or workspace config mutation.

### App

`packages/app/` becomes a pure consumer of TeamClaw APIs:

- chat/session stores consume daemon HTTP/SSE
- settings pages consume daemon workspace-control APIs
- no direct OpenCode SDK usage
- no direct `opencode.json` or `.opencode/` file IO
- no `start_opencode` preload or `restartOpencode` lifecycle model

### OpenCode

OpenCode remains a daemon-managed backend implementation:

- launched by daemon as an ACP-compatible runtime
- invisible to desktop/app as a public network endpoint
- replaceable in the future without rewriting the UI contract

---

## Public API Design

The daemon should expose two public API families: session/runtime APIs and workspace control APIs.

### §1 Session and runtime APIs

These become the only runtime-facing APIs used by the app.

- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/:id`
- `DELETE /v1/sessions/:id`
- `POST /v1/sessions/:id/prompt`
- `POST /v1/sessions/:id/cancel`
- `GET /v1/sessions/:id/events`
- `GET /v1/sessions/:id/stream`
- `POST /v1/sessions/:id/model`
- `POST /v1/sessions/:id/permissions/:request_id`
- `POST /v1/sessions/:id/restart`

Required semantics:

1. The session API speaks in TeamClaw `SessionSnapshot`, `PromptAck`, and `SessionEvent` terms, not OpenCode session/message types.
2. Event delivery uses the TeamClaw SSE vocabulary already established in `apps/daemon/src/http/events.rs`.
3. Model switching and permission replies are explicit HTTP actions instead of OpenCode SDK helper calls.
4. Session restart is daemon-owned. Frontend callers never stop/start OpenCode directly.

### §2 Workspace control APIs

These become the only settings-facing APIs used by the app.

- `GET /v1/workspaces/:workspace_id/runtime`
- `POST /v1/workspaces/:workspace_id/runtime/reload`
- `GET /v1/workspaces/:workspace_id/providers`
- `PUT /v1/workspaces/:workspace_id/providers`
- `POST /v1/workspaces/:workspace_id/providers/:provider_id/auth`
- `DELETE /v1/workspaces/:workspace_id/providers/:provider_id/auth`
- `GET /v1/workspaces/:workspace_id/mcp`
- `PUT /v1/workspaces/:workspace_id/mcp`
- `POST /v1/workspaces/:workspace_id/mcp/:server_name/test`
- `GET /v1/workspaces/:workspace_id/skills`
- `PUT /v1/workspaces/:workspace_id/skills`
- `GET /v1/workspaces/:workspace_id/roles`
- `PUT /v1/workspaces/:workspace_id/roles`
- `GET /v1/workspaces/:workspace_id/permissions`
- `PUT /v1/workspaces/:workspace_id/permissions`
- `GET /v1/workspaces/:workspace_id/permission-allowlist`
- `PUT /v1/workspaces/:workspace_id/permission-allowlist`

Required semantics:

1. These APIs return TeamClaw-defined resource shapes rather than raw `opencode.json` fragments.
2. Daemon is free to persist via OpenCode-compatible files behind the scenes.
3. Every mutating API returns whether the change was applied live, queued for reload, or requires runtime restart.
4. Test operations such as MCP connectivity run inside daemon, not in frontend or desktop command code.

---

## Internal Daemon Design

To avoid hard-coding OpenCode file semantics into every handler, daemon needs an internal abstraction boundary.

### §3 WorkspaceControlStore

Add a daemon-internal workspace control abstraction that owns logical reads/writes for:

- providers
- MCP servers
- skills
- roles
- permissions
- allowlist rules

This trait should expose TeamClaw-native shapes and hide storage details from route handlers.

### §4 OpenCodeCompatStore

Add an implementation of `WorkspaceControlStore` that maps logical TeamClaw data to:

- `opencode.json`
- `.opencode/skills`
- `.opencode/roles`
- OpenCode permission/allowlist DB

This store is the compatibility layer that preserves existing workspaces during migration.

### §5 RuntimeSupervisor

Add a daemon-internal runtime supervisor responsible for:

- workspace runtime readiness
- reload vs restart decisioning after config changes
- restart requests for a single session or workspace runtime
- surfacing runtime health/capabilities to the `runtime` control API

### §6 SessionRuntimeAdapter

Replace the stub-oriented HTTP adapter path with a real adapter that:

- translates HTTP session actions into `RuntimeManager` calls
- translates ACP/OpenCode runtime events into TeamClaw `SessionEvent` values
- preserves monotonic per-session sequencing for SSE replay

This adapter becomes the universal boundary between frontend-facing HTTP and backend-facing runtime internals.

---

## Migration Plan

The implementation should land in four phases.

### Phase A: Move the chat runtime path to daemon

Primary objective: the app no longer depends on OpenCode HTTP or `@opencode-ai/sdk` for chat/session flows.

Changes:

- turn `apps/daemon/src/http/runtime_adapter.rs` into a real `RuntimeManager` adapter
- finish event translation from ACP/runtime updates to TeamClaw SSE
- introduce an app-side daemon client for sessions/streaming
- switch message/session stores to daemon `/v1/sessions/*`
- delete the app's dependency on `start_opencode` preload as a chat prerequisite

Exit criteria:

- session create/send/stream/cancel all work through daemon
- model selection during active runtime works through daemon APIs
- permission requests/replies flow through daemon

### Phase B: Move provider and permission control to daemon

Primary objective: the most commonly used settings pages stop reading files and stop talking to OpenCode directly.

Changes:

- add daemon provider APIs and provider auth mutation APIs
- add daemon permission config and allowlist APIs
- move `LLMSection` and `PermissionManagementSection` to daemon APIs
- remove direct `opencode.json` file reads/writes from the frontend
- remove `restartOpencode()` from these flows

Exit criteria:

- provider connect/disconnect/custom provider edit works via daemon
- permission defaults and DB allowlist are visible and editable via daemon
- frontend no longer needs filesystem access for these settings

### Phase C: Move MCP, skills, and roles control to daemon

Primary objective: all workspace control surfaces are daemon-owned.

Changes:

- add daemon MCP/skills/roles APIs
- migrate settings/store/marketplace flows to daemon
- move skill/role install/update/delete logic into daemon-side compatibility store implementations
- keep current `.opencode/*` directory layout under daemon control for compatibility

Exit criteria:

- MCP settings no longer use Tauri `mcp` commands
- skills/roles UI no longer assumes direct filesystem ownership
- frontend can manage all OpenCode-derived workspace assets through daemon only

### Phase D: Remove desktop OpenCode control-plane ownership

Primary objective: desktop stops acting as an OpenCode supervisor.

Changes:

- delete or retire most of `apps/desktop/src/commands/opencode.rs`
- delete or retire `apps/desktop/src/commands/mcp.rs`
- remove `OpenCodeState` dependencies from other desktop modules such as cron init
- remove Tauri command registrations for `start_opencode`, `stop_opencode`, and `get_opencode_status`
- replace app readiness checks with daemon connectivity/runtime readiness checks

Exit criteria:

- app startup does not depend on desktop-side OpenCode lifecycle IPC
- desktop only ensures daemon availability
- OpenCode is now fully behind daemon

---

## File and Module Impact

Expected high-impact changes by area:

### Daemon

- `apps/daemon/src/http/runtime_adapter.rs`
- `apps/daemon/src/http/routes.rs`
- new HTTP handler modules for providers, MCP, skills, roles, permissions, runtime status
- `apps/daemon/src/runtime/manager.rs`
- `apps/daemon/src/runtime/adapter.rs`
- new workspace-control storage modules under `apps/daemon/src/config/` or a dedicated subtree

### App

- remove or demote `packages/app/src/lib/opencode/sdk-client.ts`
- remove or demote `packages/app/src/lib/opencode/preloader.ts`
- replace with `packages/app/src/lib/daemon-client.ts` or equivalent
- update session/message/runtime stores
- update `LLMSection.tsx`
- update `PermissionManagementSection.tsx`
- update MCP/Skills/Roles settings flows

### Desktop

- `apps/desktop/src/commands/opencode.rs`
- `apps/desktop/src/commands/mcp.rs`
- any command path currently resolving workspace through `OpenCodeState`
- `apps/desktop/src/lib.rs` command registration

---

## Compatibility Strategy

Compatibility is retained only below the daemon boundary.

### Preserved compatibility

- daemon continues to launch OpenCode via `[agents.opencode]`
- daemon continues to read/write `opencode.json` when needed
- daemon continues to use `.opencode/skills` and `.opencode/roles`
- daemon continues to interoperate with the OpenCode permission DB/allowlist data

### Intentionally dropped compatibility

- app no longer consumes OpenCode SDK APIs
- app no longer treats OpenCode HTTP on `127.0.0.1:13141` as a public dependency
- desktop no longer exposes OpenCode lifecycle/config IPC as a frontend API

This split gives existing workspaces a soft migration path without preserving the wrong public boundary.

---

## Risks and Mitigations

### Risk 1: Provider/model semantics diverge from current OpenCode SDK assumptions

Current UI paths often assume provider/model lists come from OpenCode SDK shapes.

Mitigation:

- define TeamClaw-native provider/model DTOs early
- add adapter-level mapping tests from runtime/provider sources to these DTOs
- keep provider IDs stable where possible to reduce UI churn

### Risk 2: Skills and roles are strongly coupled to `.opencode/` directory conventions

Mitigation:

- retain current disk layout in `OpenCodeCompatStore` for the first migration
- move only ownership, not storage shape, during the first pass

### Risk 3: Permission state is split across config JSON and DB allowlist

Mitigation:

- daemon returns a unified permissions resource that clearly separates default policy vs per-project allowlist
- frontend stops merging these two sources manually

### Risk 4: Some config changes may require restart instead of live reload

Mitigation:

- daemon must explicitly classify changes as `applied_live`, `reload_required`, or `restart_required`
- settings UI should surface this state instead of assuming a silent live apply

### Risk 5: Transition period may create duplicate logic across frontend and daemon

Mitigation:

- prioritize deleting app/desktop direct paths immediately after daemon parity exists
- avoid "long-lived bridge mode" where both OpenCode SDK and daemon remain equal first-class APIs

---

## Testing Strategy

### Daemon

- unit tests for `WorkspaceControlStore` and `OpenCodeCompatStore` mappings
- unit tests for session event translation and sequencing
- integration tests for `/v1/sessions/*` with real adapter behavior
- integration tests for workspace-control HTTP routes

### App

- store/component tests updated to use daemon client mocks instead of OpenCode SDK mocks
- regression tests for settings pages using daemon response fixtures

### Desktop

- compile- and smoke-level verification that removed OpenCode commands are no longer needed by startup flows
- targeted tests for daemon bootstrap/probe logic if that shell path changes

---

## Acceptance Criteria

This migration is complete when all of the following are true:

1. The app can run chat/session flows without `@opencode-ai/sdk` and without direct access to OpenCode HTTP.
2. Provider, permission, MCP, skills, and roles settings all route through daemon-owned APIs.
3. Desktop does not own OpenCode lifecycle or workspace config mutation.
4. OpenCode can still be used as the daemon's `AgentType::Opencode` backend for existing workspaces.
5. Replacing OpenCode with another backend in the future would require daemon-internal changes only, not frontend protocol rewrites.

---

## Recommended Implementation Order

1. Finish the daemon runtime adapter and switch chat/session flows first.
2. Move providers and permissions next because they are the highest-frequency settings paths.
3. Move MCP, skills, and roles after the runtime/control foundation exists.
4. Remove desktop OpenCode control-plane ownership last, once app callers are fully off those IPCs.

This order maximizes user-visible progress while reducing the risk of a prolonged mixed-boundary state.
