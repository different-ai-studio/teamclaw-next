# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For **UI / visual design** work, source-of-truth depends on the platform:

- **iOS** (`apps/ios/`): `apps/ios/DESIGN.md` — the Hai 灰 palette, wabi-sabi
  language, and SwiftUI implementation conventions (tokens, Hai sheets, iOS 26
  toolbar rules). Read this before touching anything in `apps/ios/`.
- **Web / desktop** (`packages/app/`): `AGENTS.md` at the repo root — the
  Editorial Calm direction (paper neutrals, coral accent, Chinese-first type).

## Git Workflow

If `docs/SDLC.md` exists in this checkout, read it before starting any change.
It is a local, git-ignored SDLC override for this workspace.

**Never push directly to `main`.** All changes must go through a Pull Request:

1. Create or reuse a project-local worktree under `.worktrees/` before making
   changes
2. Do all file edits, verification, and commits inside that worktree
3. Patch the diff into `.worktrees/preview-integration` so the user can verify
   it live (see the "Single-preview multi-agent workflow" section below)
4. **Wait for the user to explicitly ask you to open the PR.** Do not push the
   branch or run `gh pr create` on your own initiative — even if the worktree
   work looks "done", tests pass, and the diff has been accepted into preview.
   An explicit "open the PR", "ship it", "提 PR", or "可以提 PR 了" from the
   user is the trigger; absent that, stop after the preview-integration commit
   and report back.
5. Do not merge or push to `main` directly, even for small fixes

**Why this matters:** the user runs a worktree-develop → preview-integration
patch → human verification → PR pipeline. Agents that race ahead and open a
PR before the human has tested the change in preview break that pipeline.
When in doubt, stop and ask.

**All AI-made changes must happen in a project-local worktree.** Do not edit the
stable repo checkout directly. If the user asks for a change and you are not
already inside the right worktree, create one under `.worktrees/<task-slug>` and
work there. Creating the branch needed for that worktree is part of the normal
workflow and does not require a separate approval when the user has requested
the change.

Do not switch branches in an existing checkout to start work. Use
`scripts/create-agent-worktree.sh <task-slug> <base-ref>` instead of raw
`git worktree add` so the new checkout gets the local env/config files needed
for preview and self-test. Keep branches task-scoped and short-lived, then
remove the worktree after the PR is merged or the task is abandoned.

Local files copied into new worktrees when present:

- `.env` and `.env.local` — root secrets for deploy, backend, Supabase, push,
  MQTT, and other live/self-test workflows.
- `packages/app/.env.development.local` — required for the web/desktop Vite
  preview to get `VITE_SUPABASE_*` and MQTT settings.
- `apps/daemon/.env` — optional. Set `TEAMCLAW_CLOUD_API_URL` to override the
  Cloud API endpoint that `amuxd init` POSTs `/v1/invites/claim` to (defaults
  to the production `https://cloud.ucar.cc`).
- `apps/expo/.env` — required for Expo when doing mobile work; the tracked
  `.env.example` is only a template.
- `apps/android/local.properties` — required for Android builds to find the
  local SDK.

Tracked config such as `build.config.local.json`, `build.config.production.json`,
`apps/daemon/.env.example`, `apps/expo/.env.example`, and
`apps/android/secrets.defaults.properties` comes from git automatically and
does not need manual copying.

### Single-preview multi-agent workflow

When several agents work in parallel but the user wants only one live
hot-reload preview, use a dedicated integration worktree. Do not run one dev
server per agent branch.

Layout:

```text
teamclaw-v2/                         # stable repo checkout, not edited by agents
teamclaw-v2/.worktrees/
  preview-integration/               # the only hot-reload preview worktree
  agent-<name>-candidate/            # one isolated candidate worktree per agent
```

Rules:

- Run the single preview instance from `.worktrees/preview-integration` only
  (`pnpm dev` for frontend preview; use `pnpm tauri:dev` only when native
  desktop behavior must be checked).
- Each agent works in its own `agent-<name>-candidate` worktree and does not
  start a dev server.
- Candidate worktrees produce diffs. Apply selected diffs into
  `preview-integration` automatically when the user wants to inspect them.
- After applying a selected diff to `preview-integration`, commit it
  immediately as a local WIP commit. Do not leave accepted preview changes as a
  long-lived unstaged diff.
- If the user rejects the last applied candidate, revert the corresponding WIP
  commit from `preview-integration`.
- If the user wants to continue forward, apply the next candidate diff on top
  of the existing accepted WIP commits.
- When all accepted changes look good, open the PR from the
  `preview-integration` branch. The accepted diffs are the PR contents.
- After the PR is merged and no local work needs to be preserved, remove the
  preview and candidate worktrees.

Keep the integration branch fresh:

- Rebase `preview-integration` onto `origin/main` before starting a new round of
  agent candidates.
- Rebase again after every few accepted WIP commits if other people are landing
  related changes.
- Rebase immediately before opening the PR.
- If rebase conflicts appear, stop applying new candidate diffs until the
  integration worktree is reconciled with `origin/main`.

## Project Overview

TeamClaw is an AI Agent Desktop Platform built with Tauri 2.0 + React 19. Three-column layout chat/collaboration tool with local AI agents, team P2P/OSS sync, and multi-channel gateways.

## Commands

```bash
# Install
pnpm install

# Dev
pnpm dev                    # Frontend only (Vite)
pnpm tauri:dev              # Full Tauri desktop app
pnpm rust:check             # Fast Rust compile check with shared .cargo-target
pnpm rust:build             # Rust build with shared .cargo-target
pnpm daemon:run             # Run amuxd from apps/daemon
pnpm ios:run                # Build, install, and launch iOS app on booted Simulator

# Build
pnpm tauri:build            # Production build
pnpm tauri:build:debug      # Debug build
pnpm tauri:build:mac:all    # macOS dual-arch (ARM64 + Intel)
pnpm daemon:build           # Build daemon
pnpm ios:build              # Build iOS simulator app

# Lint & Typecheck
pnpm lint                   # ESLint (frontend)
pnpm typecheck              # TypeScript strict
cargo fmt --check --manifest-path apps/desktop/Cargo.toml
cargo clippy --manifest-path apps/desktop/Cargo.toml -- -D warnings

# Test
pnpm test:unit              # Vitest unit tests
pnpm test:e2e               # E2E (requires built app + tauri-mcp)
pnpm test:smoke             # Smoke subset
pnpm daemon:test            # Daemon tests
pnpm ios:test:core          # AMUXCore SwiftPM tests
pnpm ios:test               # iOS UI tests

# FC deploy
bash .claude/skills/fc-deploy/deploy.sh
```

## Architecture

**Monorepo layout:**
- `packages/app/` — React 19 frontend (TypeScript, Tailwind 4, Zustand, Vite)
- `apps/desktop/` — Rust/Tauri backend (commands, RAG via Tantivy, STT via Whisper, P2P via iroh)
- `apps/daemon/` — amuxd daemon (ACP runtime, MQTT/Supabase bridge)
- `apps/ios/` — iOS app, Xcode project, and Swift packages
- `services/supabase/` — Supabase migrations, seed, and database tests
- `services/fc/` — Alibaba Cloud Function Compute (Node.js 20, serverless team API)
- `crates/` — shared Rust crates (`teamclaw-proto`, `teamclaw-types`, `teamclaw-transport`)
- `tests/` — E2E tests (tauri-mcp): smoke, regression, performance, functional

**Frontend key paths:**
- `packages/app/src/stores/` — Zustand stores (50+ files, global state)
- `packages/app/src/components/` — React components (editors, chat, diff)
- `packages/app/src/lib/` — Utilities (RAG, git, skills)
- `packages/app/src/hooks/` — React hooks

**Rust backend key paths:**
- `apps/desktop/src/commands/` — Tauri IPC commands (oss_sync, team_p2p, gateway/, cron/, etc.)
- `apps/desktop/src/rag/` — Full-text search + embeddings
- `apps/desktop/binaries/` — sidecar binaries (teamclaw-introspect, etc.)

**Editor system:** Markdown (Tiptap) / HTML (Tiptap + sandbox preview) / Code (CodeMirror 6 + Shiki)

## Backend Access Boundary — Cloud API is the default backend

**`cloud_api` is the default and canonical backend. The `supabase` backend kind is deprecated and will be removed in a future release.**

The API contract is defined in `docs/openapi/teamclaw-api.v1.yaml`. All business data operations must go through the TeamClaw Cloud API (`/v1`) rather than direct Supabase client calls.

The Cloud API facade (`services/fc/lib/business-api.mjs`) is the canonical entry point for teams, sessions, messages, and invite operations. Clients (Tauri, Expo, iOS, daemon) should use their respective Cloud API providers:

- **Web/Desktop** (`packages/app/`): `CloudApiProvider` in `packages/app/src/lib/backend/provider.ts`
- **Expo** (`apps/expo/`): `createCloudSessionsApi` in `apps/expo/src/features/sessions/cloud-api.ts`
- **iOS** (`apps/ios/`): `CloudAPIClient` / `CloudAPIRepositories` in `apps/ios/Packages/AMUXCore/Sources/AMUXCore/CloudAPI/`
- **daemon** (`apps/daemon/`): `cloud_api` backend module in `apps/daemon/src/backend/cloud_api.rs`

Direct Supabase client usage (e.g. `supabase.from('sessions').select()`) is **reserved for internal FC repository implementation only** (`services/fc/lib/supabase-repo.mjs`). The FC facade forwards caller bearer tokens to Supabase, preserving RLS and auth semantics. The deprecated `supabase` backend kind in client config files is a legacy fallback — do not use it for new deployments.

**When adding new business endpoints:**

1. Define the endpoint in `docs/openapi/teamclaw-api.v1.yaml` first.
2. Implement the repository contract in `services/fc/lib/repository-contract.mjs`.
3. Add the route handler in `services/fc/lib/business-api.mjs`.
4. Implement the Supabase passthrough in `services/fc/lib/supabase-repo.mjs`.
5. Add tests in `services/fc/test/` (route, repository, contract).
6. Wire the endpoint into client Cloud API providers.

Do not bypass the Cloud API and call Supabase directly from client code. The facade exists so future backend replacements (MySQL, other storage) happen inside FC without client rewrites.

## Streaming Architecture (Critical)

Single source of truth principle — **never mix content sources**:
- **Streaming phase**: display from `streamingContent` (built from delta buffer)
- **Completed phase**: display from `message.content` (built from `message.parts[]`)
- **Never** write to `msg.content` during streaming
- **Never** use "longest content" strategy on completion

## Team Collaboration

- **P2P mode**: iroh-based (Linux/macOS only)
- **S3/OSS mode**: Alibaba OSS with WebDAV
- Shared: `skills/`, `.mcp/`, `knowledge/`

## Versioning & Release

**Version numbers** — Desktop version must match across `package.json`, `apps/desktop/Cargo.toml`, `apps/desktop/tauri.conf.json`.

**Release process:**
1. Bump desktop version in all 3 files
2. Commit, push to main
3. `git tag v<desktop-version> && git push origin v<desktop-version>`
4. Tag push triggers `release.yml` (macOS desktop)

## iOS TestFlight Release

**Version file:** `apps/ios/project.yml` — `MARKETING_VERSION` (e.g. `1.1.5`) + `CURRENT_PROJECT_VERSION` (build number, increment by 1 each release).

**Release process:**
1. Bump `CURRENT_PROJECT_VERSION` in `apps/ios/project.yml`
2. Commit and push to main
3. `git tag ios-v<version>-<build> && git push origin ios-v<version>-<build>`
   - Example: `git tag ios-v1.1.5-4 && git push origin ios-v1.1.5-4`
4. Tag push triggers `.github/workflows/testflight.yml` (runs `fastlane beta` on CI)

**Tag format must be `ios-v*`** — other formats (e.g. `ios-1.1.5-4`) do not trigger the workflow.

## FC (Function Compute) Deployment

FC function `teamclaw-sync` is deployed to Alibaba Cloud cn-shenzhen region.

Deploy: use the `fc-deploy` skill (`.claude/skills/fc-deploy/deploy.sh`).

Production endpoint: `https://cloud.ucar.cc`

FC endpoints: `/register`, `/token`, `/reset-secret`, `/apply`, `/ai/setup-team`, `/ai/add-member`, `/ai/remove-member`, `/ai/keys`, `/ai/usage`, `/ai/budget`, `/managed-git/create-repo`
