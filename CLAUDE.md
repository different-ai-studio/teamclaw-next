# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For **UI / visual design** work, source-of-truth depends on the platform:

- **iOS** (`apps/ios/`): `apps/ios/DESIGN.md` — the Hai 灰 palette, wabi-sabi
  language, and SwiftUI implementation conventions (tokens, Hai sheets, iOS 26
  toolbar rules). Read this before touching anything in `apps/ios/`.
- **Web / desktop** (`packages/app/`): `AGENTS.md` at the repo root — the
  Editorial Calm direction (paper neutrals, coral accent, Chinese-first type).

## Git Workflow

**Never push directly to `main`.** All changes must go through a Pull Request:

1. Create a feature branch before making any changes
2. Commit work to the feature branch
3. Push and open a PR via `gh pr create`
4. Do not merge or push to `main` directly, even for small fixes

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
