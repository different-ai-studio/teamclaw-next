# FC OpenAPI Supabase Proxy

**Date:** 2026-05-27
**Status:** Draft for review
**Scope:** OpenAPI contract, FC business API facade, Supabase passthrough repository

## Summary

TeamClaw should move Tauri, Expo, iOS, and daemon business data access behind a
TeamClaw-owned HTTP contract before changing any backing database. This phase is
a versioned OpenAPI contract and an FC implementation that forwards business
operations to Supabase using the caller's access token.

The target shape is:

```text
Tauri / Expo / iOS / daemon
  -> TeamClaw Cloud API client
    -> FC /v1 business API
      -> Supabase passthrough repository
```

Supabase remains the backing system in this phase. Realtime is out of scope
because the product does not use Supabase Realtime for the target architecture.
Storage is also out of scope and remains on the existing client paths until a
separate attachment/storage API is designed.

## Goals

- Define a versioned OpenAPI contract for TeamClaw business operations.
- Add FC `/v1/*` business routes that implement the contract.
- Forward the caller's `Authorization: Bearer <access_token>` to Supabase so
  existing Supabase Auth, RLS, and RPC behavior remains authoritative.
- Keep endpoint names domain-oriented, not generic Supabase proxy names.
- Preserve current Supabase schema, RPCs, RLS, and client behavior.
- Leave a repository boundary so a future backend replacement can happen inside
  FC without another client rewrite.
- Keep the first implementation thin enough to review and test quickly.

## Non-Goals

- No MySQL integration, schema, migration, repository implementation, or MySQL
  migration planning beyond keeping the FC repository boundary replaceable.
- No Supabase Storage migration.
- No Supabase Realtime support.
- No auth provider replacement.
- No client migration in the first spec commit.
- No Web or Android migration in this plan.
- No new mobile feature work.
- No daemon transport redesign.
- No raw generic endpoint such as `POST /supabase/from/:table` for product
  clients.

## Constraints

- The clients in scope are peers. Tauri, Expo, iOS, and daemon should all be
  able to call FC directly.
- Daemon is a digital agent client, not Tauri's data proxy.
- Tauri may still manage some daemon local configuration and control-plane
  state, but that is separate from cloud business data.
- Access token passthrough is acceptable for phase 1. FC does not need to mint
  its own session token yet.
- Existing Supabase RLS/RPC behavior should remain the correctness oracle while
  FC is only a facade.

## Architecture

```text
clients/
  packages/app          -> Tauri surface Cloud API backend using generated TS types
  apps/expo             -> Cloud API client using generated TS types
  apps/ios              -> hand-written thin client from contract
  apps/daemon           -> AgentCloudBackend using the same contract

services/fc/
  index.mjs             -> FC HTTP entrypoint
  lib/business-api.mjs  -> /v1 route dispatcher
  lib/repository.js     -> BusinessRepository interface shape
  lib/supabase-repo.mjs -> Supabase token-passthrough repository

docs/openapi/
  teamclaw-api.v1.yaml  -> canonical API contract
```

The FC API owns business semantics. The Supabase repository is an implementation
detail. Clients should depend on `teamclaw-api.v1.yaml`, not Supabase table,
filter, or RPC shapes.

Existing FC paths such as `/register`, `/token`, `/ai/*`, `/managed-git/*`,
and `/push/dispatch` remain stable legacy routes. They are not renamed in this
phase. New business-data endpoints must use `/v1/*`; do not add new product
business APIs to the legacy root path. A future admin/API cleanup can add
versioned aliases, but this migration does not need that compatibility work.

## API Versioning

All new endpoints live under `/v1`.

Rules:

- Additive fields and endpoints can stay in `/v1`.
- Request or response breaking changes require `/v2`.
- Each response object should be stable even if the current Supabase row has
  extra fields.
- Prefer request bodies over query-string filter languages for complex reads.

## OpenAPI Tooling

The first implementation should use:

- `openapi-typescript` for TypeScript types.
- A tiny shared fetch wrapper for Tauri, Expo, and daemon TypeScript tests.
- A hand-written Swift client against the same OpenAPI schema until code
  generation quality is proven for iOS.

The OpenAPI file is still the source of truth. Client helpers should be thin and
should not invent field names, error codes, or pagination shapes that are absent
from the spec.

OpenAPI CI should run a spec lint step before type generation. Prefer Redocly
or Spectral; pick the lighter dependency during implementation. The lint gate
must at least catch invalid references, missing response schemas, duplicate
operation IDs, and accidental removal of required fields.

The iOS client is hand-written initially, so it needs a drift guard. iOS tests
should record the OpenAPI spec hash they were reviewed against.
When `docs/openapi/teamclaw-api.v1.yaml` changes, iOS tests fail until the
hash is updated after reviewing whether the hand-written client needs changes.

## Authentication

Clients call FC with the current user or agent access token:

```http
Authorization: Bearer <supabase_access_token>
```

FC validates only the presence and shape of the header in phase 1. For business
calls it constructs a Supabase client with:

- project URL from FC environment
- publishable key from `SUPABASE_PUBLISHABLE_KEY`, falling back to
  `SUPABASE_ANON_KEY` for current deployments
- global `Authorization` header set to the caller's bearer token

The result is:

- Supabase Auth identifies the caller.
- Supabase RLS and RPC permission checks continue to apply.
- FC does not need a service-role key for normal business operations.

Service-role usage remains allowed only for existing operational paths such as
push dispatch until those paths are separately migrated.

Phase 1 does not parse unverified JWT claims. For logs and rate-limit
correlation, FC records a short SHA-256 fingerprint of the bearer token and the
request id. If caller identity is needed inside FC later, add verified JWT
validation through Supabase JWKS before using `sub`, `role`, or any other claim
for logs, limits, or behavior. Authorization decisions remain in Supabase during
this phase. Logs must never include the bearer token.

Daemon access in phase 1 uses the same rule as every other client: it can call
FC only when it has a Supabase-compatible access token. Existing long-lived
daemon refresh-token flows can continue to obtain that token through the
Supabase legacy path. If an agent later receives a non-Supabase token, FC must
support an explicit token-exchange endpoint before daemon can use the Cloud API;
silently passing that token through to Supabase would be expected to fail.

## Request Identity and Idempotency

Every FC response should include:

```http
X-Request-Id: <request-id>
```

If the caller supplies `X-Request-Id`, FC may reuse it only when it matches:

```text
^[A-Za-z0-9_-]{8,64}$
```

Otherwise FC generates one.

Write endpoints that can be retried by clients should accept:

```http
Idempotency-Key: <client-generated-key>
```

Phase 1 chooses narrow idempotency, not a general Stripe-style
`idempotency_keys` table. No schema change is added. For
`POST /v1/sessions/{sessionId}/messages`, the `Idempotency-Key` must equal the
client-supplied message id when present. FC rejects mismatched values with
`validation_failed`. Duplicate inserts for the same message id are treated as a
successful replay only when the existing row's stable request fields match the
incoming request. General request replay with stored response blobs is deferred
until a dedicated idempotency table is approved.

## Error Model

FC should normalize errors into a small envelope:

```json
{
  "error": {
    "code": "forbidden",
    "message": "Permission denied",
    "requestId": "optional-request-id"
  }
}
```

Initial code mapping:

- `missing_auth` -> 401
- `invalid_json` -> 400
- `validation_failed` -> 400
- `conflict` -> 409
- `not_found` -> 404
- `rate_limited` -> 429
- `upstream_unavailable` -> 502
- Supabase 401/403 -> 401/403
- Supabase no-row where expected -> 404
- Postgres `42501` insufficient privilege -> 403 `forbidden`
- Postgres `23505` unique violation -> 409 `conflict`
- Postgres `23503` foreign-key violation -> 400 `validation_failed`
- Postgres `23514` check violation -> 400 `validation_failed`
- Supabase unknown error -> 502
- FC unexpected error -> 500

Allowed `error.code` values for `/v1` are:

- `missing_auth`
- `invalid_json`
- `validation_failed`
- `forbidden`
- `not_found`
- `conflict`
- `rate_limited`
- `upstream_unavailable`
- `internal`

Do not leak service-role keys, tokens, SQL fragments, or full Supabase error
objects in client responses. Log detail server-side.

## Pagination

List endpoints should use one envelope shape:

```json
{
  "items": [],
  "nextCursor": "opaque-or-null"
}
```

The cursor is an opaque string from the client's perspective. FC may encode the
current Supabase cursor fields internally, but callers should not assemble SQL
cursor pieces such as `last_message_at`, `created_at`, or `id`.

## `/v1/me` Shape

`GET /v1/me` returns the current Supabase-authenticated user and all actor
identities visible to that user:

```json
{
  "user": {
    "id": "user-id",
    "email": "user@example.com"
  },
  "currentActorId": "actor-id",
  "actors": [
    {
      "id": "actor-id",
      "teamId": "team-id",
      "actorType": "member",
      "displayName": "Matt",
      "role": "owner"
    }
  ],
  "featureRouting": {
    "sessions.list": "supabase_legacy",
    "messages.list": "supabase_legacy"
  }
}
```

`currentActorId` is the server-recommended default for the current client
session. Clients may let the user switch actor/team when multiple entries are
present.

## V1 Target Surface

The first contract should cover the minimum cross-client collaboration surface:

### Auth and Onboarding

- `POST /v1/invites/claim`
  - maps to `claim_team_invite`
- `GET /v1/me`
  - returns current user and actor summaries

### Teams

- `GET /v1/teams`
  - lists current user's teams
- `POST /v1/teams`
  - maps to `create_team`
- `GET /v1/teams/{teamId}`
- `PATCH /v1/teams/{teamId}`
  - maps to `rename_team`
- `POST /v1/teams/{teamId}/invites`
  - maps to `create_team_invite`
- `DELETE /v1/actors/{actorId}`
  - maps to `remove_team_actor`

### Actors and Agents

- `GET /v1/teams/{teamId}/actors`
  - returns actor directory rows
- `GET /v1/teams/{teamId}/agents/connected`
  - maps to `list_connected_agents`
- `PATCH /v1/agents/{agentId}/profile`
  - maps to `update_owned_agent_profile`
- `PATCH /v1/agents/{agentId}/defaults`
  - maps to `update_agent_defaults`
- `GET /v1/agents/{agentId}/access`
- `POST /v1/agents/{agentId}/access`
- `DELETE /v1/agent-access/{accessId}`

### Sessions

- `GET /v1/sessions`
  - supports `limit`, cursor fields, and current-actor filtering
  - maps to `list_current_actor_sessions`
- `POST /v1/sessions`
  - creates session shell and participants
- `GET /v1/sessions/{sessionId}`
- `PATCH /v1/sessions/{sessionId}`
  - title/archive updates
- `POST /v1/sessions/{sessionId}/view`
  - maps to `mark_current_actor_session_viewed`
- `GET /v1/sessions/{sessionId}/participants`
- `POST /v1/sessions/{sessionId}/participants`
- `DELETE /v1/sessions/{sessionId}/participants/{actorId}`

### Messages

- `GET /v1/sessions/{sessionId}/messages`
- `POST /v1/sessions/{sessionId}/messages`
  - inserts outgoing user/agent message
- `PATCH /v1/messages/{messageId}`
  - content update

### Agent Runtime

- `GET /v1/teams/{teamId}/agent-runtimes`
- `GET /v1/sessions/{sessionId}/runtime-targets`
- `PATCH /v1/agent-runtimes/{runtimeId}/model`

### Workspaces

- `GET /v1/teams/{teamId}/workspaces`
- `POST /v1/teams/{teamId}/workspaces`
- `PATCH /v1/workspaces/{workspaceId}`

## Deferred API Surface

These are intentionally excluded from the first API batch:

- Attachment upload and signed URLs.
- Supabase Storage object movement.
- Notification push dispatch internals.
- Realtime notification APIs. Live notification and delivery continue through
  MQTT and are outside this HTTP business contract.
- Full shortcut role/permission management if it slows the first collaboration
  API pass.
- Bulk offline sync endpoints.
- Admin/service-role endpoints.

## BusinessRepository Strategy

FC business routes should call a repository interface, not expose Supabase
primitives:

```js
createBusinessRepository({ accessToken }).sessions.listCurrentActorSessions(args)
createBusinessRepository({ accessToken }).messages.insertOutgoingMessage(input)
```

The first implementation is `SupabaseRepository`. Future backend work can add
another repository behind the same interface. This repository boundary is the
planned swap point; clients and route handlers should not change when a future
backend replacement arrives.

Internally those methods may call:

- Supabase `.from(...)`
- Supabase `.rpc(...)`
- existing SQL functions

The route layer should not know table or RPC names. It should validate HTTP
input, call the repository, and map output/error envelopes.

## Contract Compatibility

The compatibility guardrail is a shared Repository contract test suite. It
treats `BusinessRepository` as a black box and exercises behavior, not
implementation details.

Phase 1 should create the suite skeleton and run it against:

- `SupabaseRepository` with mocked transport for normal unit feedback.
- `SupabaseRepository` with a real Supabase test branch in CI when branch
  credentials are available.

Future repository implementations must run the same suite against both
`SupabaseRepository` and the new repository. The following behavior must match
across repositories unless a later spec explicitly documents a divergence:

- auth/RLS denial maps to the same `forbidden` error code
- unique conflicts map to `conflict`
- validation failures map to `validation_failed`
- list default ordering
- cursor monotonicity and no duplicate rows across pages
- create/list read-after-write shape for implemented endpoints
- duplicate message id replay behavior

Response shapes also need golden fixtures. Each implemented `/v1` endpoint gets
one happy-path JSON fixture under the contract test tree. Tauri, Expo, iOS, and
daemon tests should consume those fixtures where practical so field renames fail
CI instead of becoming runtime drift.

## Shadow Read and Runtime Routing

`VITE_BACKEND_KIND=cloud_api` is not sufficient for production migration. It is
a development override only. Runtime migration uses a method-level routing
table:

```json
{
  "sessions.list": "shadow",
  "messages.list": "supabase_legacy",
  "messages.insert": "supabase_legacy"
}
```

Supported route values:

- `supabase_legacy`
- `cloud_api`
- `shadow`

In `shadow` mode, the client calls both the legacy Supabase provider and the
Cloud API provider, returns the legacy result to the UI, and reports normalized
diffs to Sentry or the existing telemetry path. After one to two days of clean
diffs for an internal team, that method can move to `cloud_api`.

Routing can be scoped by endpoint, user, team, and platform. FC may return the
initial routing table from `/v1/me`; clients should also support a locally saved
emergency override so the route can be rolled back at runtime without a new app
release. Writes should not run in dual-write mode in this phase unless a
separate idempotency and rollback design is approved.

## OpenAPI Contract Strategy

The canonical spec lives at:

```text
docs/openapi/teamclaw-api.v1.yaml
```

It should define:

- shared error envelope
- auth security scheme
- request/response schemas only for implemented endpoints
- path operations grouped by tags
- stable field names matching TeamClaw domain vocabulary

OpenAPI and FC implementation ship incrementally together. Do not predefine the
entire V1 Target Surface as executable schema before implementing it; that would
turn the spec into a wish list and let clients code against endpoints that
return 404. Each PR adds schemas only for the endpoints implemented in that PR.

## Migration Plan

### Phase 1: Contract and FC Facade

- Add `docs/openapi/teamclaw-api.v1.yaml`.
- Add FC `/v1` dispatcher and Supabase business repository.
- Add Repository contract test suite skeleton and first golden response
  fixtures.
- Implement the smallest endpoint slice:
  - teams list/get
  - sessions list
  - messages list/insert
  - invite claim
- Do not implement the whole V1 Target Surface in one PR.
- Inventory the exact Supabase RPC/table response shapes for only those
  implemented endpoints and copy the real shapes into OpenAPI.
- Add node tests for:
  - missing bearer token
  - bearer token is forwarded to Supabase client
  - Supabase client factory receives the expected `Authorization` header
  - route calls correct repository method
  - Supabase errors become normalized HTTP errors
  - `X-Request-Id` is returned
  - idempotent message insert accepts `Idempotency-Key`
- Add a CI path for live Supabase contract tests when ephemeral branch
  credentials are configured.

### Phase 2: Tauri CloudApiBackend

- Add `cloud_api` to `BackendKind`.
- Add `packages/app/src/lib/backend/cloud-api/**`.
- Keep `TeamClawBackend` interface unchanged where possible for Tauri.
- Add method-level runtime provider routing.
- Start with one low-risk read path in `shadow` mode, not hard-cut
  `cloud_api`.

### Phase 3: Daemon AgentCloudBackend

- Add daemon `cloud_api` provider config.
- Implement daemon agent business methods against FC.
- Keep Supabase legacy provider as rollback.
- Do not route Tauri data through daemon.

### Phase 4: Expo Migration

- Replace Expo Supabase API modules with Cloud API client methods.
- Keep Supabase modules as legacy providers until parity is proven.

### Phase 5: iOS Migration

- Add an iOS Cloud API client from the OpenAPI contract.
- Migrate the first low-risk iOS read path behind a runtime route flag.
- Keep Supabase repositories as legacy providers until parity is proven.

## Testing

Initial tests should include:

- FC unit tests with fake Supabase client factory.
- OpenAPI lint/validation.
- `openapi-typescript` generation check.
- Repository contract test suite skeleton.
- Snapshot or shape tests for normalized response envelopes.

Supabase Branching for contract tests:

- CI should create an ephemeral Supabase branch when the configured Supabase MCP
  or CI credentials support branch creation.
- Run local migrations and seed data against that branch.
- Run the Repository contract tests against the real branch using normal bearer
  tokens.
- Delete the branch at the end of the job.
- If branch tooling is unavailable in a given environment, the live contract job
  may skip, but release/merge policy should treat that as a setup gap, not as
  equivalent coverage.

- Client contract tests for `CloudApiBackend`.
- Daemon contract tests for `AgentCloudBackend`.
- Shadow-read diff tests for the first migrated client read path.

## Open Questions

- Should the first OpenAPI validation test use a lightweight parser dependency
  or rely on generated TypeScript type output as the validation signal?
- Should daemon token exchange be designed before Phase 3, or should Phase 3
  initially require a Supabase-compatible daemon access token?
- Should Supabase branch contract tests be mandatory for every PR or only for
  PRs that change `services/fc`, `docs/openapi`, or repository code?

## Decisions

- FC uses `SUPABASE_PUBLISHABLE_KEY` as the canonical passthrough key env var
  and falls back to `SUPABASE_ANON_KEY` for compatibility.
- `/v1/me` returns `{ user, actors }`, not just the first actor, because clients
  need actor switching and role-aware UI.
- Shortcuts do not ship in the first endpoint slice. Add them after
  sessions/messages are proven.
- Phase 1 uses narrow message-id idempotency. It does not add a generic
  idempotency table.
- New `/v1` OpenAPI schemas are added only for endpoints implemented in the
  same PR.
- MySQL and other backend replacements are intentionally future work. This spec
  only keeps the FC repository boundary replaceable.
- Legacy FC paths keep their existing credentials. The Cloud API client handles
  Supabase bearer auth for `/v1`; legacy FC helpers keep their current
  X-Team-Token, service-role webhook secret, or endpoint-specific credentials.
  Do not mix those auth modes inside one generic request helper.

## Acceptance Criteria

- A reviewer can read the OpenAPI spec and understand the first supported
  business operations without knowing Supabase table names.
- FC `/v1` routes use the caller bearer token when calling Supabase.
- FC tests prove the Supabase client receives the expected `Authorization`
  header.
- Repository contract tests exist and run against the implemented
  `SupabaseRepository` endpoints.
- The first client migration uses method-level shadow read before switching to
  `cloud_api`.
- Existing FC endpoints continue to work.
- No storage or realtime behavior is changed.
- No client is forced to migrate until `CloudApiBackend` exists and is
  explicitly selected.
