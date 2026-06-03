# OpenCode Runtime Refresh Handoff

## Current Branch

- Branch: `codex/daemon-model-ordering-fix`
- HEAD: `fbea6341` - `Tighten refresh watcher tests`

## Current Workspace State

- The worktree is dirty.
- Modified files currently visible in this checkout:
  - `apps/daemon/src/config/workspace_control.rs`
  - `apps/daemon/src/daemon/collab_runtime_ensure.rs`
  - `apps/daemon/src/daemon/runtime_resolution.rs`
  - `apps/daemon/src/daemon/server.rs`
  - `apps/daemon/src/http/state.rs`
  - `apps/daemon/src/http/workspaces.rs`
  - `apps/daemon/src/runtime/refresh_watch.rs`
  - `apps/daemon/src/runtime/supervisor.rs`

## Goal

Finish the OpenCode runtime refresh control plane so that:

- daemon-owned config mutations are tracked as refresh state
- watcher-originated external edits surface through the same refresh status
- the UI can show a workspace banner and session hint for pending refreshes
- the final implementation is verified and ready for handoff/PR

## What Is Already In Place

### Daemon refresh core

- `RuntimeRefreshCoordinator` exists in `apps/daemon/src/runtime/refresh.rs`.
- `RuntimeStatus` now carries a refresh DTO instead of relying on a loose optional shape.
- `GET /v1/workspaces/:id/runtime` and `POST /v1/workspaces/:id/runtime/reload` are wired through the refresh coordinator.
- Provider/auth/permission mutations already record refresh changes into the shared state.

### Watchers

- A watcher module exists at `apps/daemon/src/runtime/refresh_watch.rs`.
- It has basic V1 classification for:
  - workspace `.teamclaw/skills`
  - workspace `.opencode/skills`
  - global `~/.config/teamclaw/skills`
  - global `~/.config/opencode/skills`
  - `opencode.json`
- There are tests for path classification and debouncing.

### Frontend provider flow

- The provider store no longer owns its own runtime-reload messaging for provider auth changes.
- Delete-provider-auth handling was made explicit so failures fail closed.
- `customProviderIds` now follows the `custom-` id convention instead of misclassifying daemon-authenticated built-ins.

## Remaining Work

All handoff tasks are implemented in the current dirty tree. Before opening a PR, run:

```bash
# Daemon watcher + refresh coordinator
cd apps/daemon && cargo test --bin amuxd refresh_watch::

# Frontend refresh UX + store
cd packages/app && pnpm exec vitest run \
  src/stores/__tests__/workspace-runtime-refresh.test.ts \
  src/components/workspace/__tests__/RuntimeRefreshBanner.test.tsx \
  src/lib/__tests__/workspace-runtime-refresh-labels.test.ts
pnpm typecheck
```

### Completed in this pass

**Task 4 — watcher hardening (daemon)**

- `workspace_runtime_id()` (base64url path encoding) is used for watcher registration and HTTP queries.
- `RefreshWatchRegistry` supports dynamic upsert/remove on workspace add/remove.
- V1 skill roots include `.claude/skills`, `.agents/skills`, and global `~/.claude` / `~/.agents`.
- Integration tests cover coordinator recording and `runtime_status` with HTTP workspace IDs.

**Task 5 — frontend UX**

- `GET /v1/workspaces/:id/runtime` client (`getDaemonRuntime`) + `useWorkspaceRuntimeRefreshStore` polling.
- `RuntimeRefreshWorkspaceBanner` under the main header; `RuntimeRefreshSessionHint` above the chat composer.
- Apply wired to `POST …/runtime/reload` via `reloadDaemonRuntime`.
- Legacy `hasSkillRestartPrompt` overlay removed from `ChatPanel` (daemon refresh state is the source of truth).

**Task 6 — verification**

- Targeted daemon and app tests pass; `packages/app` `typecheck` passes.

## Important Files

- `apps/daemon/src/runtime/refresh.rs`
- `apps/daemon/src/runtime/refresh_watch.rs`
- `apps/daemon/src/runtime/supervisor.rs`
- `apps/daemon/src/daemon/server.rs`
- `apps/daemon/src/http/state.rs`
- `apps/daemon/src/http/workspaces.rs`
- `packages/app/src/stores/provider.ts`
- `packages/app/src/stores/__tests__/provider.test.ts`

## Known Caveats

- The watcher implementation was kept intentionally minimal for V1.
- Some broader daemon test targets still have unrelated compile issues in this checkout, so the best signal so far has been focused `--bin amuxd` and package-scoped app tests.
- Avoid destructive git commands like `git reset --hard`; there are existing dirty changes in the tree.

## Suggested Resume Sequence

1. Inspect the current diff with `git status --short` and `git diff --stat`.
2. Resolve the watcher correctness issues first.
3. Add or adjust tests so the watcher path proves end-to-end refresh state recording.
4. Move on to Task 5 UI wiring.
5. Run focused verification and then broader package checks.

