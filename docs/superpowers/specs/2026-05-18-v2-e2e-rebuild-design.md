# V2 E2E Rebuild Design

Date: 2026-05-18

## Goal

Rebuild TeamClaw's E2E test strategy for the current V2 app by making the old
test debt visible and introducing a small, stable V2 PR gate.

The first phase has two outputs:

1. An audit matrix for existing `tests/e2e`, `tests/functional`, and
   `tests/regression` files.
2. A first V2 E2E track that protects the conversation critical path:
   session list, session switching, prompt send, agent streaming, tool calls,
   completion, and persisted history.

## Non-Goals

- Do not rewrite every existing E2E test in phase one.
- Do not put file tree, settings, team configuration, telemetry, notifications,
  or P2P coverage into the first PR gate.
- Do not depend on live model quality or external network services in the PR
  gate.
- Do not revive live Thinking or Permission Request rendering. Those surfaces
  remain disabled in the main thread per `AGENTS.md`.

## Test Tracks

### V2 PR Gate

Directory: `tests/v2-e2e/pr/`

Purpose: fast, deterministic tests that must pass on ordinary PRs.

Budget: 8 minutes or less for the full track.

Backend: controlled V2 test backend.

Scope in phase one:

- seeded session list
- session creation and switching
- isolated message history
- prompt send
- streaming lifecycle
- tool call success and error rendering
- completed run persistence

### V2 Nightly / Manual Real Chain

Directory: `tests/v2-e2e/nightly/`

Purpose: low-count smoke tests against the real daemon, MQTT, Supabase, and
configured model path.

Budget: slower than the PR gate is acceptable.

Failure handling: not part of the ordinary PR gate. Failures should preserve
screenshots, logs, and session identifiers for diagnosis.

### Legacy Manual Track

Existing directories remain in place during phase one:

- `tests/e2e/`
- `tests/functional/`
- `tests/regression/`

They should remain runnable through a legacy script but should not be treated
as the default E2E quality signal until audited and migrated.

Recommended script semantics:

```json
{
  "test:e2e": "pnpm test:e2e:v2:pr",
  "test:e2e:v2:pr": "vitest run --config vitest.config.v2-e2e.ts tests/v2-e2e/pr",
  "test:e2e:v2:nightly": "vitest run --config vitest.config.v2-e2e.ts tests/v2-e2e/nightly",
  "test:e2e:legacy": "vitest run --config vitest.config.e2e.ts tests/e2e tests/functional tests/regression"
}
```

## Controlled V2 Backend Strategy

The PR track should not drive the app by mutating DOM state directly. It should
exercise the real V2 UI, stores, adapters, and renderers through explicit test
control APIs.

Preferred control boundary:

- Tauri IPC test commands when available.
- `tauri-mcp` `callIpcCommand` or `executeJs` helpers as the test access path.
- A small TypeScript helper layer wrapping those calls, for example
  `v2Test.seedConversation(...)`, `v2Test.emitAgentDelta(...)`, and
  `v2Test.completeRun(...)`.

The controlled backend must be able to deterministically produce:

- team, actor, session, participant, and message seed data
- session create/switch behavior
- user prompt sent events
- agent output deltas
- tool call started/completed/error events
- run completed events
- persisted history reloads
- session list preview and ordering updates

The tests may still click and type through the UI for user-facing workflows,
especially composer send and session selection. Backend-side events should be
driven through explicit test APIs rather than fragile coordinate clicks or
arbitrary localStorage state injection.

## Test Data Isolation

All V2 E2E data uses a test namespace:

- session titles and team names include `e2e-${timestamp}` or a generated run id
- workspace paths use temporary directories
- controlled backend data is cleaned up after each suite
- nightly real-chain tests preserve artifacts on failure

The PR track should be safe to run repeatedly on developer machines and CI.

## First V2 PR Tests

### V2-PR-01: Session List Loads Seeded Conversations

Seed three sessions with different `last_message_at`, preview text, actors, and
participants.

Assertions:

- V2 three-column shell is present.
- Session list rows are ordered by `last_message_at` descending.
- Active row is visually selected.
- Preview text is rendered from V2 session list data.
- Participant avatar cluster is visible for rows with participants.

### V2-PR-02: Create / Switch Session Preserves Isolated History

Create or seed sessions A and B with different user and agent messages.

Assertions:

- Selecting session A shows only A messages.
- Selecting session B shows only B messages.
- Header meta and active session row update together.
- Returning to A restores A history without message bleed.

### V2-PR-03: Prompt Send and Agent Streaming Lifecycle

Use the composer to send a prompt through the UI, then drive agent events from
the controlled backend.

Assertions:

- Sent prompt appears as a user message.
- Agent output deltas render incrementally in the thread.
- Completion switches display from streaming state to persisted history.
- Completed content is not duplicated.
- Composer returns to an interactive state.

### V2-PR-04: Tool Call and Error Surfaces Render Deterministically

Drive tool events through the controlled backend.

Assertions:

- Tool start renders a pending/in-progress card.
- Tool success renders status and result summary.
- Tool error renders the error state.
- Thinking and Permission Request live-thread surfaces are not rendered.

## Nightly Real-Chain Smoke

The first nightly track should stay small:

1. Launch the app with a real workspace.
2. Verify daemon/connectivity readiness is visible or introspectable.
3. Create a real session.
4. Send one low-cost prompt.
5. Observe at least one agent response or a classified, user-visible failure.
6. Reload or relaunch and verify session history is still accessible.

This test is for integration drift, not detailed UI regression coverage.

## Legacy Audit Matrix

Audit document: `docs/testing/e2e-audit.md`

Table columns:

```md
| File | Current Track | Decision | Reason | V2 Replacement | Notes |
```

Allowed decisions:

- `keep-legacy-manual`: still useful, but not part of the PR gate.
- `migrate-v2-pr`: must be rewritten into the V2 PR track.
- `migrate-v2-nightly`: requires real external services or integration state.
- `downgrade-unit`: better expressed as component, store, static, or config test.
- `delete`: placeholder, screenshot-only, obsolete, contradictory, or low value.

Default audit rules:

- Placeholder tests with comment-only steps and screenshot-only assertions should
  be deleted or rewritten.
- Permission Request live-thread tests should be deleted or moved to a future
  revival spec because the live surface is disabled today.
- Static config or source-text checks should be downgraded out of E2E.
- Old layout or copy assertions that contradict the current V2 Editorial Calm
  shell should be deleted or rewritten.
- Real P2P, telemetry sync, gateway, and external integration tests should move
  to nightly or legacy manual unless they become deterministic.

## Policy for New E2E Tests

Any new E2E test must declare:

- track: `v2-pr`, `v2-nightly`, or `legacy-manual`
- backend: controlled or real chain
- product risk covered
- expected runtime budget
- cleanup strategy

Tests that do not protect a real user or release risk should not enter
`tests/v2-e2e/pr/`.

## Implementation Sequence

1. Create the audit document and classify existing E2E files.
2. Add `vitest.config.v2-e2e.ts` and the new package scripts.
3. Add the V2 E2E helper layer and controlled backend control surface.
4. Implement `V2-PR-01` through `V2-PR-04`.
5. Move default `test:e2e` to the V2 PR gate only after the first V2 tests pass
   locally.
6. Add the first nightly real-chain smoke test.
7. Use the audit matrix to remove, downgrade, or migrate legacy tests in small
   batches.

## Acceptance Criteria

- `pnpm test:e2e:v2:pr` runs the new V2 PR track in 8 minutes or less.
- The first four V2 PR tests pass deterministically with the controlled backend.
- `pnpm test:e2e` points at the V2 PR gate.
- `pnpm test:e2e:legacy` still gives access to old E2E-style tests.
- `docs/testing/e2e-audit.md` exists and classifies every current file under
  `tests/e2e`, `tests/functional`, and `tests/regression`.
- No phase-one PR test requires a live model response or external network
  service.
