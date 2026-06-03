# OpenCode Runtime Refresh Control Plane — Design Spec

**Date:** 2026-06-03  
**Status:** Approved  
**Scope:** Full (Option 3 + Option 2 UX) — all OpenCode-related runtime-affecting changes, covering TeamClaw desktop UI mutations and external file changes, with idle auto-reload plus active-session apply prompts

## Problem

After OpenCode moved behind the daemon, many changes no longer take effect until the user manually "restarts OpenCode" or reloads the workspace runtime. The current behavior exists, but it is fragmented:

- skills save/import calls `reloadDaemonRuntime()` from the UI
- provider auth changes trigger a special-case runtime reload path
- env var changes can request reload after save
- MCP changes return `RestartRequired`, but there is no unified pending-change model
- direct edits outside TeamClaw (IDE, Finder, git pull) are not consistently detected

The result is inconsistent UX and unclear semantics:

- some changes interrupt running sessions immediately
- some only affect future sessions
- some produce no clear indication that the running runtime is stale
- frontend code has to guess whether a change needs reload or restart

We need one daemon-owned refresh control plane that:

1. detects runtime-affecting changes from both UI and filesystem sources
2. classifies impact consistently
3. auto-applies safe changes when the workspace is idle
4. avoids silently interrupting active sessions
5. tells the user exactly what is pending and what action will make it take effect

## Goals

1. Make daemon the single authority for deciding whether a change is live-applied, queued, or requires runtime recycle.
2. Cover all runtime-affecting OpenCode surfaces:
   - skills
   - MCP config
   - env vars / secret-backed config inputs
   - provider auth / provider catalog-affecting config
   - relevant `opencode.json` mutations
3. Detect both TeamClaw-initiated mutations and out-of-band file edits.
4. Use a balanced policy:
   - workspace idle: auto reload/restart when safe
   - active session exists: do not interrupt; mark pending and prompt the user to apply
5. Surface pending changes at two levels:
   - workspace-level banner/status
   - active-session-level hint
6. Keep the design extensible so later versions can move to a fingerprint/versioned runtime model without redoing the API.

## Non-Goals

- Hot-patching a running ACP/OpenCode process in place.
- Replaying interrupted agent turns automatically after a forced restart.
- Supporting headless-only daemon workflows in V1.
- Solving every non-OpenCode daemon reload problem with the same mechanism.
- Guaranteeing semantic diffing of arbitrary file edits outside the known watched config surfaces.

## Current State

There is already a partial reload path:

- `packages/app/src/lib/daemon-local-client.ts` exposes `reloadDaemonRuntime()`
- `apps/daemon/src/http/workspaces.rs` routes `POST /v1/workspaces/:id/runtime/reload`
- `apps/daemon/src/runtime/supervisor.rs::reload_workspace()`:
  - runs `prepare_workspace()`
  - stops runtime(s) for the workspace
  - evicts ACP hosts so future attaches pick up fresh auth/config

This path is useful, but it is too coarse and too manually invoked. It does not model:

- what changed
- whether the change was detected internally or externally
- whether the runtime is currently stale
- whether reload was auto-applied or deferred because the workspace is active
- what the user should do next

## Design Summary

Introduce a daemon-owned **Runtime Refresh Control Plane** with four parts:

1. **Change detection**
   - structured mutation events from TeamClaw UI flows
   - filesystem watchers for external edits
2. **Change classification**
   - map each detected change to a normalized refresh impact
3. **Workspace refresh state**
   - daemon keeps per-workspace pending refresh state and apply history
4. **Apply orchestration**
   - idle workspace: auto-apply
   - active workspace: defer and prompt

The existing `reload_workspace()` implementation remains the low-level actuator in V1. The new control plane decides *when* and *why* to call it, and what UX state to expose before and after.

## Architecture

### 1. New daemon service: `RuntimeRefreshCoordinator`

Add a new daemon-owned component, likely under `apps/daemon/src/runtime/refresh.rs`, responsible for:

- ingesting workspace change events
- maintaining per-workspace refresh state
- coalescing duplicate/noisy events
- deciding whether to auto-apply now or defer
- invoking `RuntimeSupervisor` reload operations
- exposing read APIs for the frontend

`RuntimeRefreshCoordinator` becomes the single place that answers:

- Is this workspace runtime stale?
- Why is it stale?
- Can the daemon apply the change now?
- Was it already applied?

### 2. New shared refresh model

Add daemon-native types such as:

```rust
enum RefreshChangeKind {
    Skills,
    Mcp,
    EnvVars,
    ProviderAuth,
    ProviderCatalog,
    Permissions,
    OpencodeJson,
}

enum RefreshSource {
    UiMutation,
    FilesystemWatch,
    StartupRescan,
}

enum RefreshImpact {
    AppliedLive,
    IdleReload,
    IdleRestart,
    UserApplyRequired,
}

enum WorkspaceRefreshStatus {
    Clean,
    Pending,
    Applying,
    Failed,
}
```

Per-workspace state should include:

- workspace id/path
- current status
- pending change kinds
- first/last detected timestamps
- source set
- recommended action
- whether any active runtime/session prevented auto-apply
- last apply attempt result

### 3. New watcher layer

Add daemon filesystem watchers for known runtime-affecting surfaces:

- `<workspace>/opencode.json`
- `<workspace>/.teamclaw/skills/**`
- `<workspace>/.opencode/skills/**`
- optional global skill dirs already scanned by roles/skills inventory:
  - `~/.config/teamclaw/skills/**`
  - `~/.config/opencode/skills/**`
- any daemon-owned generated config that materially changes runtime spawn inputs

The watcher layer should normalize noisy file churn:

- debounce burst writes
- collapse rename/write/remove sequences into one event batch
- map path changes to `RefreshChangeKind`

It is acceptable in V1 to classify unknown `opencode.json` diffs conservatively as `OpencodeJson`.

### 4. UI mutation events go through the same coordinator

When TeamClaw mutates runtime-affecting state from the UI, it should not directly decide restart behavior. Instead:

- write the config as today
- notify daemon refresh coordinator of the semantic change
- let coordinator decide whether to apply immediately or defer

This keeps TeamClaw-owned mutations and external edits on the same semantic path.

## Change Classification Matrix

V1 classification should be explicit and conservative.

| Change kind | Typical examples | Default impact when idle | Default impact when active |
|------------|------------------|--------------------------|----------------------------|
| `Skills` | create/edit/import/delete skill | `IdleReload` | `UserApplyRequired` |
| `Mcp` | add/remove server, command/env/header change | `IdleRestart` | `UserApplyRequired` |
| `EnvVars` | personal/team env save/delete that can affect spawn/MCP/provider refs | `IdleReload` | `UserApplyRequired` |
| `ProviderAuth` | OAuth callback, API key update/removal | `IdleReload` | `UserApplyRequired` |
| `ProviderCatalog` | provider model/base-url config edits | `IdleReload` | `UserApplyRequired` |
| `Permissions` | permission defaults / skill permission map | `IdleReload` | `UserApplyRequired` |
| `OpencodeJson` | external raw edit to relevant config surface | `IdleReload` or `IdleRestart` based on changed section | `UserApplyRequired` |

Rules:

- `Mcp` is treated as the strongest impact in V1 because server process topology changes are easiest to reason about via full recycle.
- If multiple change kinds are pending, the strongest impact wins.
- `AppliedLive` remains available for future low-risk cases, but V1 should use it sparingly.
- In V1, both `IdleReload` and `IdleRestart` may reuse the same low-level `reload_workspace()` actuator; the distinction is semantic and API-visible first, so we preserve room for a more granular executor later.

## Runtime Semantics

### Clean vs stale

A workspace is:

- **clean** when no unapplied runtime-affecting changes are pending
- **stale** when at least one detected change has not yet been applied to the currently usable runtime path

Staleness is workspace-scoped, not session-scoped, but the UI can project it into the active session.

### Idle vs active

For V1, a workspace is considered **active** when any runtime handle for that workspace is in:

- `Starting`
- `Active`
- `Idle`

This matches current `active_handles_for_workspace()` behavior and errs on the side of not interrupting something the user may resume soon.

Later versions may distinguish truly idle-but-attached from actively responding turns, but that is not required for this spec.

### Apply behavior

When a change is detected:

1. coordinator merges it into the workspace pending state
2. coordinator computes the strongest impact
3. if the workspace has no active runtime handles:
   - auto-apply immediately
4. if active handles exist:
   - do not stop them automatically
   - mark pending
   - expose recommended action to UI

Manual "Apply changes" from the UI calls the same coordinator and uses the same apply path.

## API Changes

### 1. Expand runtime status API

Extend `GET /v1/workspaces/:id/runtime` to include refresh state, for example:

```json
{
  "workspace_id": "...",
  "ready": true,
  "backend": "opencode",
  "current_model": "openai/gpt-5",
  "refresh": {
    "status": "pending",
    "change_kinds": ["skills", "env_vars"],
    "recommended_action": "apply_changes",
    "auto_apply_blocked_by_active_runtime": true,
    "last_detected_at": "2026-06-03T12:34:56Z"
  }
}
```

### 2. Replace "dumb reload" with apply-intent semantics

Keep `POST /v1/workspaces/:id/runtime/reload` for compatibility, but redefine it as:

- "apply pending workspace runtime changes now"

Optionally add a clearer alias in V1 or V2:

- `POST /v1/workspaces/:id/runtime/apply-refresh`

The response should distinguish:

- no pending changes
- applied now
- deferred because runtime became active
- apply failed

### 3. New daemon-internal refresh event hook

Add an internal interface used by:

- skills save/import/delete handlers
- provider auth flows
- env var save/delete flows
- MCP/permission/workspace control writes
- filesystem watchers

Example shape:

```rust
async fn record_workspace_change(
    workspace_id: &str,
    workspace_path: &Path,
    kind: RefreshChangeKind,
    source: RefreshSource,
)
```

## Frontend UX

### 1. Workspace-level prompt

Show a workspace-level status/banner when refresh state is pending:

- "此工作区有运行时变更待应用"
- secondary line lists the detected kinds, for example:
  - `Skills, MCP, 环境变量 已更新`
- primary action:
  - `应用变更`

If auto-apply succeeded while idle, surface a lightweight toast instead of leaving a sticky banner:

- `运行时已自动刷新`

### 2. Active session hint

When the current session belongs to a workspace with pending refresh:

- show a subtle inline note in the thread/composer area
- wording should explain that future replies continue using the old runtime until changes are applied

Example:

- `Skills 和 MCP 已更新。为立即生效，请先应用变更。`

### 3. Settings pages stop owning restart semantics

Skills, MCP, env var, and provider settings pages should:

- perform their write
- refresh their own local list/state
- rely on daemon refresh status for UX

They may still call an explicit "apply now" action after save if the page is designed that way, but they should not invent their own interpretation of restart requirements.

## Daemon Implementation Plan

### Phase 1: Coordinator + state only

- Add `RuntimeRefreshCoordinator`
- Track per-workspace pending refresh state
- Add APIs to read/apply refresh status
- Route existing UI-driven reload points through the coordinator

This phase already unifies semantics for TeamClaw-owned writes.

### Phase 2: Filesystem watch coverage

- Add watchers for workspace/global skills and `opencode.json`
- Debounce and classify changes
- Feed them into the same coordinator

This phase solves the "edited outside TeamClaw" problem.

### Phase 3: UX and cleanup

- Extend runtime status payload
- add workspace/session prompts
- remove page-specific stale restart warnings where they become redundant

## Failure Handling

If apply fails:

- workspace refresh state moves to `Failed`
- pending changes remain recorded
- API returns structured failure
- frontend shows a non-destructive error with retry action

The daemon must not clear pending state on failed apply.

Watcher failures should be non-fatal:

- log warning
- keep existing state
- allow manual apply from UI

If a watched path disappears temporarily during git operations or editor replace-save behavior:

- debounce before classifying as delete
- prefer re-scan after quiet period over eager failure

## Testing

### Daemon unit tests

- change coalescing picks strongest impact
- active workspace blocks auto-apply
- idle workspace auto-applies
- failed apply preserves pending state
- duplicate filesystem burst collapses to one pending change set
- `opencode.json` section mapping classifies MCP vs skills vs generic config edits

### Daemon integration tests

- skill write through workspace-control path records `Skills` change
- provider OAuth callback records `ProviderAuth` change
- env var save records `EnvVars` change
- manual apply calls existing reload actuator and clears state on success
- external file edit on watched skill dir produces pending refresh state

### Frontend tests

- runtime status with pending refresh shows workspace banner
- active session shows inline hint
- clicking `应用变更` calls apply endpoint and clears prompt on success
- idle auto-apply path shows toast, not sticky warning

## Migration / Compatibility

This spec does not require removing the current `reload_workspace()` actuator. V1 explicitly reuses it.

Compatibility guarantees:

- existing callers of `reloadDaemonRuntime()` continue to work
- existing workspace control writes remain valid
- external edits become more reliable without changing file formats

The main behavior change is semantic:

- TeamClaw no longer treats "write completed" as equivalent to "runtime updated"
- daemon owns the authoritative answer

## Future Evolution

This design is intentionally compatible with a later fingerprint/version model.

Possible V2 upgrade:

- compute a workspace runtime fingerprint from skill/MCP/env/provider-relevant inputs
- stamp each runtime handle with the fingerprint it launched from
- replace coarse pending-state logic with exact `current_fingerprint != desired_fingerprint`

V1 should keep state fields and API names general enough that this can happen without another frontend redesign.

## Approved

User selected:

- scope: full OpenCode-related coverage
- entry coverage: desktop UI + external file changes
- UX policy: workspace-level + session-level prompts
- application policy: idle auto-apply, active-session defer-and-prompt

Confirmed OK to proceed with this design on 2026-06-03.
