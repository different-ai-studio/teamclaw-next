# FC OpenAPI Supabase Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 1 of the TeamClaw Cloud API: an OpenAPI `/v1` contract and FC facade that forwards caller bearer tokens to existing Supabase RPC/table access without changing storage, realtime, auth, or clients.

**Architecture:** FC gets a `/v1` dispatcher that validates HTTP requests, normalizes errors, and calls a `BusinessRepository`. The first repository is `SupabaseRepository`, which uses the caller's `Authorization` token against existing Supabase RPC/table APIs. The implemented endpoint slice is small: teams list/get, sessions list, messages list/insert, and invite claim.

**Tech Stack:** Node.js 20 ESM, `node:test`, `@supabase/supabase-js`, OpenAPI 3.1 YAML, `openapi-typescript`, Redocly or Spectral for linting.

---

## File Structure

- Create `docs/openapi/teamclaw-api.v1.yaml`: canonical OpenAPI contract for only the Phase 1 implemented endpoints.
- Create `services/fc/lib/http-utils.mjs`: request id, JSON parsing, bearer extraction, response helpers, and normalized error mapping.
- Create `services/fc/lib/repository-contract.mjs`: contract-test fixture definitions and repository test runner.
- Create `services/fc/lib/supabase-repo.mjs`: `SupabaseRepository` implementation and Supabase client factory with caller-token passthrough.
- Create `services/fc/lib/business-api.mjs`: `/v1` route dispatcher that maps HTTP endpoints to repository calls.
- Modify `services/fc/index.mjs`: route `/v1/*` requests to `handleBusinessApi` before legacy route handling.
- Create `services/fc/test/http-utils.test.mjs`: unit tests for request id, auth parsing, JSON parsing, and error normalization.
- Create `services/fc/test/supabase-repo.test.mjs`: unit tests for Supabase client factory header passthrough and RPC/table calls.
- Create `services/fc/test/business-api.test.mjs`: route tests for auth, request id, endpoint dispatch, idempotency, and error envelopes.
- Create `services/fc/test/repository-contract.test.mjs`: contract tests against a fake in-memory repository plus `SupabaseRepository` mocked transport.
- Create `services/fc/test/fixtures/v1/*.json`: golden response fixtures for implemented endpoints.
- Modify `services/fc/package.json`: add OpenAPI lint/typegen/test scripts and dev dependencies.

## Task 1: OpenAPI Phase 1 Contract

**Files:**
- Create: `docs/openapi/teamclaw-api.v1.yaml`
- Modify: `services/fc/package.json`

- [ ] **Step 1: Add OpenAPI scripts and dev dependencies**

Run:

```bash
cd services/fc
npm install --save-dev @redocly/cli@^1.27.2 openapi-typescript@^7.5.2
```

Then modify `services/fc/package.json` so the `scripts` block includes the two
OpenAPI commands:

```json
{
  "scripts": {
    "test": "node --test 'test/**/*.test.mjs'",
    "openapi:lint": "redocly lint ../../docs/openapi/teamclaw-api.v1.yaml",
    "openapi:types": "openapi-typescript ../../docs/openapi/teamclaw-api.v1.yaml --output /tmp/teamclaw-api.v1.d.ts"
  }
}
```

- [ ] **Step 2: Write the OpenAPI contract**

Create `docs/openapi/teamclaw-api.v1.yaml`:

```yaml
openapi: 3.1.0
info:
  title: TeamClaw Cloud API
  version: 1.0.0
servers:
  - url: https://api.teamclaw.local
security:
  - bearerAuth: []
tags:
  - name: Teams
  - name: Sessions
  - name: Messages
  - name: Invites
paths:
  /v1/teams:
    get:
      operationId: listTeams
      tags: [Teams]
      responses:
        "200":
          description: Current user's teams.
          headers:
            X-Request-Id:
              $ref: "#/components/headers/RequestId"
          content:
            application/json:
              schema:
                type: object
                required: [items, nextCursor]
                properties:
                  items:
                    type: array
                    items:
                      $ref: "#/components/schemas/Team"
                  nextCursor:
                    type: [string, "null"]
        "401":
          $ref: "#/components/responses/Error"
    post:
      operationId: createTeam
      tags: [Teams]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:
                  type: string
                  minLength: 1
                slug:
                  type: [string, "null"]
      responses:
        "200":
          description: Created team.
          headers:
            X-Request-Id:
              $ref: "#/components/headers/RequestId"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Team"
        "400":
          $ref: "#/components/responses/Error"
        "401":
          $ref: "#/components/responses/Error"
  /v1/teams/{teamId}:
    get:
      operationId: getTeam
      tags: [Teams]
      parameters:
        - $ref: "#/components/parameters/TeamId"
      responses:
        "200":
          description: Team.
          headers:
            X-Request-Id:
              $ref: "#/components/headers/RequestId"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Team"
        "404":
          $ref: "#/components/responses/Error"
  /v1/sessions:
    get:
      operationId: listSessions
      tags: [Sessions]
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 50
        - name: cursor
          in: query
          schema:
            type: string
      responses:
        "200":
          description: Current actor sessions.
          headers:
            X-Request-Id:
              $ref: "#/components/headers/RequestId"
          content:
            application/json:
              schema:
                type: object
                required: [items, nextCursor]
                properties:
                  items:
                    type: array
                    items:
                      $ref: "#/components/schemas/Session"
                  nextCursor:
                    type: [string, "null"]
  /v1/sessions/{sessionId}/messages:
    get:
      operationId: listMessages
      tags: [Messages]
      parameters:
        - $ref: "#/components/parameters/SessionId"
        - name: cursor
          in: query
          schema:
            type: string
      responses:
        "200":
          description: Session messages.
          headers:
            X-Request-Id:
              $ref: "#/components/headers/RequestId"
          content:
            application/json:
              schema:
                type: object
                required: [items, nextCursor]
                properties:
                  items:
                    type: array
                    items:
                      $ref: "#/components/schemas/Message"
                  nextCursor:
                    type: [string, "null"]
    post:
      operationId: insertMessage
      tags: [Messages]
      parameters:
        - $ref: "#/components/parameters/SessionId"
        - name: Idempotency-Key
          in: header
          schema:
            type: string
            minLength: 1
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/InsertMessageRequest"
      responses:
        "200":
          description: Inserted or replayed message.
          headers:
            X-Request-Id:
              $ref: "#/components/headers/RequestId"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Message"
        "400":
          $ref: "#/components/responses/Error"
        "409":
          $ref: "#/components/responses/Error"
  /v1/invites/claim:
    post:
      operationId: claimInvite
      tags: [Invites]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [token]
              properties:
                token:
                  type: string
                  minLength: 1
      responses:
        "200":
          description: Claimed invite.
          headers:
            X-Request-Id:
              $ref: "#/components/headers/RequestId"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ClaimInviteResult"
        "400":
          $ref: "#/components/responses/Error"
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  headers:
    RequestId:
      schema:
        type: string
  parameters:
    TeamId:
      name: teamId
      in: path
      required: true
      schema:
        type: string
    SessionId:
      name: sessionId
      in: path
      required: true
      schema:
        type: string
  responses:
    Error:
      description: Error response.
      headers:
        X-Request-Id:
          $ref: "#/components/headers/RequestId"
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/ErrorEnvelope"
  schemas:
    ErrorEnvelope:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, requestId]
          properties:
            code:
              type: string
              enum:
                - missing_auth
                - invalid_json
                - validation_failed
                - forbidden
                - not_found
                - conflict
                - rate_limited
                - upstream_unavailable
                - internal
            message:
              type: string
            requestId:
              type: string
    Team:
      type: object
      required: [id, name]
      properties:
        id:
          type: string
        name:
          type: string
        slug:
          type: [string, "null"]
        createdAt:
          type: [string, "null"]
    Session:
      type: object
      required: [id, teamId, title, mode, hasUnread]
      properties:
        id:
          type: string
        teamId:
          type: string
        title:
          type: string
        mode:
          type: string
          enum: [solo, collab, control]
        ideaId:
          type: [string, "null"]
        lastMessageAt:
          type: [string, "null"]
        lastMessagePreview:
          type: [string, "null"]
        hasUnread:
          type: boolean
        createdAt:
          type: [string, "null"]
        updatedAt:
          type: [string, "null"]
    Message:
      type: object
      required: [id, teamId, sessionId, kind, content, createdAt]
      properties:
        id:
          type: string
        teamId:
          type: string
        sessionId:
          type: string
        turnId:
          type: [string, "null"]
        senderActorId:
          type: [string, "null"]
        replyToMessageId:
          type: [string, "null"]
        kind:
          type: string
        content:
          type: string
        metadata:
          type: [object, "null"]
        model:
          type: [string, "null"]
        createdAt:
          type: string
        updatedAt:
          type: [string, "null"]
    InsertMessageRequest:
      type: object
      required: [id, teamId, senderActorId, content]
      properties:
        id:
          type: string
        teamId:
          type: string
        senderActorId:
          type: string
        content:
          type: string
        kind:
          type: string
          default: text
        metadata:
          type: [object, "null"]
        turnId:
          type: [string, "null"]
        replyToMessageId:
          type: [string, "null"]
        model:
          type: [string, "null"]
        createdAt:
          type: [string, "null"]
    ClaimInviteResult:
      type: object
      required: [actorId, teamId, actorType, displayName]
      properties:
        actorId:
          type: string
        teamId:
          type: string
        actorType:
          type: string
        displayName:
          type: string
        refreshToken:
          type: [string, "null"]
```

- [ ] **Step 3: Run OpenAPI validation commands**

Run:

```bash
cd services/fc
npm run openapi:lint
npm run openapi:types
```

Expected:

```text
No lint errors.
✨ openapi-typescript ...
```

- [ ] **Step 4: Commit**

```bash
git add services/fc/package.json services/fc/package-lock.json docs/openapi/teamclaw-api.v1.yaml
git commit -m "feat(fc): add cloud api openapi contract"
```

## Task 2: HTTP Utility Layer

**Files:**
- Create: `services/fc/lib/http-utils.mjs`
- Test: `services/fc/test/http-utils.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `services/fc/test/http-utils.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRequestId,
  errorResponse,
  getHeader,
  parseJsonBody,
  requireBearer,
  successResponse,
} from '../lib/http-utils.mjs';

test('reuses valid request id and rejects unsafe ids', () => {
  assert.equal(createRequestId({ 'x-request-id': 'Req_123456' }), 'Req_123456');
  assert.match(createRequestId({ 'x-request-id': 'bad space' }), /^[A-Za-z0-9_-]{16,64}$/);
});

test('extracts headers case-insensitively', () => {
  assert.equal(getHeader({ Authorization: 'Bearer a' }, 'authorization'), 'Bearer a');
  assert.equal(getHeader({ 'x-request-id': 'r1' }, 'X-Request-Id'), 'r1');
});

test('requires bearer auth', () => {
  assert.equal(requireBearer({ authorization: 'Bearer token-1' }), 'token-1');
  assert.throws(() => requireBearer({}), /missing_auth/);
  assert.throws(() => requireBearer({ authorization: 'Basic nope' }), /missing_auth/);
});

test('parses JSON request bodies', () => {
  assert.deepEqual(parseJsonBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonBody({ b: 2 }), { b: 2 });
  assert.throws(() => parseJsonBody('{bad'), /invalid_json/);
});

test('success responses include request id', () => {
  const res = successResponse('rid-123456', { ok: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-Request-Id'], 'rid-123456');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('error responses normalize envelope and status', () => {
  const res = errorResponse('rid-123456', { code: 'conflict', message: 'Duplicate' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.headers['X-Request-Id'], 'rid-123456');
  assert.deepEqual(JSON.parse(res.body), {
    error: { code: 'conflict', message: 'Duplicate', requestId: 'rid-123456' },
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd services/fc
npm test -- test/http-utils.test.mjs
```

Expected: FAIL with module not found for `../lib/http-utils.mjs`.

- [ ] **Step 3: Implement HTTP utilities**

Create `services/fc/lib/http-utils.mjs`:

```js
import { randomBytes } from 'node:crypto';

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const STATUS_BY_CODE = {
  missing_auth: 401,
  invalid_json: 400,
  validation_failed: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_unavailable: 502,
  internal: 500,
};

export class BusinessApiError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'BusinessApiError';
    this.code = code;
    this.cause = options.cause;
  }
}

export function createRequestId(headers = {}) {
  const supplied = getHeader(headers, 'x-request-id');
  if (supplied && REQUEST_ID_RE.test(supplied)) return supplied;
  return randomBytes(12).toString('base64url');
}

export function getHeader(headers = {}, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export function requireBearer(headers = {}) {
  const value = getHeader(headers, 'authorization');
  if (!value || !value.startsWith('Bearer ')) {
    throw new BusinessApiError('missing_auth', 'Missing bearer token');
  }
  const token = value.slice('Bearer '.length).trim();
  if (!token) throw new BusinessApiError('missing_auth', 'Missing bearer token');
  return token;
}

export function parseJsonBody(rawBody) {
  if (rawBody == null || rawBody === '') return {};
  if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) return rawBody;
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString() : String(rawBody);
    return JSON.parse(text);
  } catch (err) {
    throw new BusinessApiError('invalid_json', 'Invalid JSON body', { cause: err });
  }
}

export function successResponse(requestId, body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(requestId, error) {
  const code = error?.code && STATUS_BY_CODE[error.code] ? error.code : 'internal';
  const statusCode = STATUS_BY_CODE[code];
  const message = error?.message || 'Internal server error';
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    },
    body: JSON.stringify({ error: { code, message, requestId } }),
  };
}

export function normalizeSupabaseError(error) {
  if (!error) return null;
  const status = error.status || error.code;
  const pgCode = error.code;
  if (status === 401) return new BusinessApiError('missing_auth', error.message || 'Unauthorized', { cause: error });
  if (status === 403 || pgCode === '42501') return new BusinessApiError('forbidden', error.message || 'Forbidden', { cause: error });
  if (status === 404 || error.details === 'Results contain 0 rows') return new BusinessApiError('not_found', error.message || 'Not found', { cause: error });
  if (pgCode === '23505') return new BusinessApiError('conflict', error.message || 'Conflict', { cause: error });
  if (pgCode === '23503' || pgCode === '23514') {
    return new BusinessApiError('validation_failed', error.message || 'Validation failed', { cause: error });
  }
  return new BusinessApiError('upstream_unavailable', 'Supabase request failed', { cause: error });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
cd services/fc
npm test -- test/http-utils.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fc/lib/http-utils.mjs services/fc/test/http-utils.test.mjs
git commit -m "feat(fc): add cloud api http utilities"
```

## Task 3: Supabase Repository

**Files:**
- Create: `services/fc/lib/supabase-repo.mjs`
- Test: `services/fc/test/supabase-repo.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `services/fc/test/supabase-repo.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseClientFactory, createSupabaseRepository } from '../lib/supabase-repo.mjs';

test('client factory forwards caller bearer token', () => {
  const calls = [];
  const factory = createSupabaseClientFactory({
    createClient: (url, key, options) => {
      calls.push({ url, key, options });
      return {};
    },
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'publishable',
    },
  });
  factory('caller-token');
  assert.equal(calls[0].url, 'https://project.supabase.co');
  assert.equal(calls[0].key, 'publishable');
  assert.equal(calls[0].options.global.headers.Authorization, 'Bearer caller-token');
  assert.equal(calls[0].options.auth.persistSession, false);
});

test('list teams maps Supabase rows to API shape', async () => {
  const repo = createSupabaseRepository({
    client: {
      from(table) {
        assert.equal(table, 'teams');
        return {
          select(columns) {
            assert.equal(columns, 'id, name, slug, created_at');
            return {
              order() {
                return {
                  limit() {
                    return Promise.resolve({
                      data: [{ id: 't1', name: 'Team', slug: null, created_at: '2026-01-01T00:00:00Z' }],
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      },
    },
  });
  assert.deepEqual(await repo.teams.list({ limit: 50 }), {
    items: [{ id: 't1', name: 'Team', slug: null, createdAt: '2026-01-01T00:00:00Z' }],
    nextCursor: null,
  });
});

test('claim invite calls RPC and maps result', async () => {
  const repo = createSupabaseRepository({
    client: {
      rpc(name, args) {
        assert.equal(name, 'claim_team_invite');
        assert.deepEqual(args, { p_token: 'tok' });
        return Promise.resolve({
          data: [{ actor_id: 'a1', team_id: 't1', actor_type: 'member', display_name: 'Matt', refresh_token: null }],
          error: null,
        });
      },
    },
  });
  assert.deepEqual(await repo.invites.claim({ token: 'tok' }), {
    actorId: 'a1',
    teamId: 't1',
    actorType: 'member',
    displayName: 'Matt',
    refreshToken: null,
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd services/fc
npm test -- test/supabase-repo.test.mjs
```

Expected: FAIL with module not found for `../lib/supabase-repo.mjs`.

- [ ] **Step 3: Implement repository**

Create `services/fc/lib/supabase-repo.mjs`:

```js
import { createClient as defaultCreateClient } from '@supabase/supabase-js';
import { BusinessApiError, normalizeSupabaseError } from './http-utils.mjs';

function firstRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function requireString(value, field) {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new BusinessApiError('upstream_unavailable', `Supabase returned invalid ${field}`);
}

function mapTeam(row) {
  return {
    id: requireString(row?.id, 'team.id'),
    name: requireString(row?.name, 'team.name'),
    slug: row?.slug ?? null,
    createdAt: row?.created_at ?? null,
  };
}

function mapSession(row) {
  return {
    id: requireString(row?.id, 'session.id'),
    teamId: requireString(row?.team_id, 'session.team_id'),
    title: row?.title ?? '',
    mode: row?.mode ?? 'solo',
    ideaId: row?.idea_id ?? null,
    lastMessageAt: row?.last_message_at ?? null,
    lastMessagePreview: row?.last_message_preview ?? null,
    hasUnread: row?.has_unread === true,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapMessage(row) {
  return {
    id: requireString(row?.id, 'message.id'),
    teamId: requireString(row?.team_id, 'message.team_id'),
    sessionId: requireString(row?.session_id, 'message.session_id'),
    turnId: row?.turn_id ?? null,
    senderActorId: row?.sender_actor_id ?? null,
    replyToMessageId: row?.reply_to_message_id ?? null,
    kind: row?.kind ?? 'text',
    content: row?.content ?? '',
    metadata: row?.metadata ?? null,
    model: row?.model ?? null,
    createdAt: requireString(row?.created_at, 'message.created_at'),
    updatedAt: row?.updated_at ?? null,
  };
}

function mapClaimResult(data) {
  const row = firstRow(data);
  return {
    actorId: requireString(row?.actor_id ?? row?.actorId, 'claim.actorId'),
    teamId: requireString(row?.team_id ?? row?.teamId, 'claim.teamId'),
    actorType: requireString(row?.actor_type ?? row?.actorType, 'claim.actorType'),
    displayName: requireString(row?.display_name ?? row?.displayName, 'claim.displayName'),
    refreshToken: row?.refresh_token ?? row?.refreshToken ?? null,
  };
}

async function unwrap(result, operation) {
  const { data, error } = await result;
  if (error) throw normalizeSupabaseError(error);
  return data;
}

export function createSupabaseClientFactory({
  createClient = defaultCreateClient,
  env = process.env,
} = {}) {
  return function supabaseClientForToken(accessToken) {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new BusinessApiError('upstream_unavailable', 'Supabase configuration missing');
    }
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  };
}

export function createSupabaseRepository({ client }) {
  return {
    teams: {
      async list({ limit = 50 }) {
        const data = await unwrap(
          client.from('teams')
            .select('id, name, slug, created_at')
            .order('created_at', { ascending: true })
            .limit(limit),
          'teams.list',
        );
        return { items: (data ?? []).map(mapTeam), nextCursor: null };
      },
      async get(teamId) {
        const data = await unwrap(
          client.from('teams')
            .select('id, name, slug, created_at')
            .eq('id', teamId)
            .single(),
          'teams.get',
        );
        return mapTeam(data);
      },
    },
    sessions: {
      async list({ limit = 50, cursor = null }) {
        const data = await unwrap(
          client.rpc('list_current_actor_sessions', {
            p_limit: limit,
            p_before_last_message_at: cursor?.lastMessageAt ?? null,
            p_before_created_at: cursor?.createdAt ?? null,
            p_before_id: cursor?.id ?? null,
          }),
          'sessions.list',
        );
        return { items: (data ?? []).map(mapSession), nextCursor: null };
      },
    },
    messages: {
      async list({ sessionId }) {
        const data = await unwrap(
          client.from('messages')
            .select('id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true }),
          'messages.list',
        );
        return { items: (data ?? []).map(mapMessage), nextCursor: null };
      },
      async insert({ sessionId, input, idempotencyKey = null }) {
        if (idempotencyKey && idempotencyKey !== input.id) {
          throw new BusinessApiError('validation_failed', 'Idempotency-Key must match message id');
        }
        const row = {
          id: input.id,
          team_id: input.teamId,
          session_id: sessionId,
          sender_actor_id: input.senderActorId,
          kind: input.kind ?? 'text',
          content: input.content,
          metadata: input.metadata ?? null,
          model: input.model ?? null,
          turn_id: input.turnId ?? null,
          reply_to_message_id: input.replyToMessageId ?? null,
          ...(input.createdAt ? { created_at: input.createdAt } : {}),
        };
        const data = await unwrap(
          client.from('messages')
            .insert(row)
            .select('id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at')
            .single(),
          'messages.insert',
        );
        return mapMessage(data);
      },
    },
    invites: {
      async claim({ token }) {
        const data = await unwrap(
          client.rpc('claim_team_invite', { p_token: token }),
          'invites.claim',
        );
        return mapClaimResult(data);
      },
    },
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
cd services/fc
npm test -- test/supabase-repo.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fc/lib/supabase-repo.mjs services/fc/test/supabase-repo.test.mjs
git commit -m "feat(fc): add supabase cloud api repository"
```

## Task 4: Business API Router

**Files:**
- Create: `services/fc/lib/business-api.mjs`
- Test: `services/fc/test/business-api.test.mjs`

- [ ] **Step 1: Write failing router tests**

Create `services/fc/test/business-api.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBusinessApi } from '../lib/business-api.mjs';

function event({ method = 'GET', path, headers = {}, body = null, query = {} }) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    queryStringParameters: query,
  };
}

function fakeRepo() {
  const calls = [];
  return {
    calls,
    teams: {
      list: async (args) => { calls.push(['teams.list', args]); return { items: [{ id: 't1', name: 'Team', slug: null, createdAt: null }], nextCursor: null }; },
      get: async (teamId) => { calls.push(['teams.get', teamId]); return { id: teamId, name: 'Team', slug: null, createdAt: null }; },
    },
    sessions: {
      list: async (args) => { calls.push(['sessions.list', args]); return { items: [], nextCursor: null }; },
    },
    messages: {
      list: async (args) => { calls.push(['messages.list', args]); return { items: [], nextCursor: null }; },
      insert: async (args) => { calls.push(['messages.insert', args]); return { id: args.input.id, teamId: args.input.teamId, sessionId: args.sessionId, kind: 'text', content: args.input.content, createdAt: '2026-01-01T00:00:00Z', turnId: null, senderActorId: args.input.senderActorId, replyToMessageId: null, metadata: null, model: null, updatedAt: null }; },
    },
    invites: {
      claim: async (args) => { calls.push(['invites.claim', args]); return { actorId: 'a1', teamId: 't1', actorType: 'member', displayName: 'Matt', refreshToken: null }; },
    },
  };
}

test('rejects missing bearer auth', async () => {
  const repo = fakeRepo();
  const res = await handleBusinessApi(event({ path: '/v1/teams' }), {
    createRepository: () => repo,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).error.code, 'missing_auth');
});

test('lists teams and returns request id', async () => {
  const repo = fakeRepo();
  const res = await handleBusinessApi(event({
    path: '/v1/teams',
    headers: { authorization: 'Bearer token', 'x-request-id': 'Req_123456' },
  }), { createRepository: () => repo });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-Request-Id'], 'Req_123456');
  assert.deepEqual(JSON.parse(res.body).items[0], { id: 't1', name: 'Team', slug: null, createdAt: null });
  assert.deepEqual(repo.calls[0], ['teams.list', { limit: 50 }]);
});

test('inserts message with idempotency key', async () => {
  const repo = fakeRepo();
  const res = await handleBusinessApi(event({
    method: 'POST',
    path: '/v1/sessions/s1/messages',
    headers: { authorization: 'Bearer token', 'idempotency-key': 'm1' },
    body: { id: 'm1', teamId: 't1', senderActorId: 'a1', content: 'hi' },
  }), { createRepository: () => repo });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0][0], 'messages.insert');
  assert.equal(repo.calls[0][1].idempotencyKey, 'm1');
  assert.equal(JSON.parse(res.body).id, 'm1');
});

test('claims invite', async () => {
  const repo = fakeRepo();
  const res = await handleBusinessApi(event({
    method: 'POST',
    path: '/v1/invites/claim',
    headers: { authorization: 'Bearer token' },
    body: { token: 'invite-token' },
  }), { createRepository: () => repo });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0], ['invites.claim', { token: 'invite-token' }]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
cd services/fc
npm test -- test/business-api.test.mjs
```

Expected: FAIL with module not found for `../lib/business-api.mjs`.

- [ ] **Step 3: Implement router**

Create `services/fc/lib/business-api.mjs`:

```js
import {
  BusinessApiError,
  createRequestId,
  errorResponse,
  getHeader,
  parseJsonBody,
  requireBearer,
  successResponse,
} from './http-utils.mjs';
import { createSupabaseClientFactory, createSupabaseRepository } from './supabase-repo.mjs';

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || 'GET';
}

function pathOf(event) {
  return event.rawPath || event.path || '/';
}

function queryOf(event) {
  return event.queryStringParameters || {};
}

function parsePositiveLimit(raw, fallback = 50) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new BusinessApiError('validation_failed', 'limit must be an integer between 1 and 100');
  }
  return n;
}

function requireField(body, field) {
  const value = body?.[field];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new BusinessApiError('validation_failed', `${field} is required`);
}

function defaultCreateRepository(accessToken) {
  const client = createSupabaseClientFactory()(accessToken);
  return createSupabaseRepository({ client });
}

export async function handleBusinessApi(event, deps = {}) {
  const requestId = createRequestId(event.headers || {});
  try {
    const accessToken = requireBearer(event.headers || {});
    const repo = (deps.createRepository || defaultCreateRepository)(accessToken);
    const method = methodOf(event);
    const path = pathOf(event);
    const query = queryOf(event);
    const body = method === 'GET' ? {} : parseJsonBody(event.body);

    if (method === 'GET' && path === '/v1/teams') {
      return successResponse(requestId, await repo.teams.list({ limit: parsePositiveLimit(query.limit) }));
    }

    const teamMatch = path.match(/^\/v1\/teams\/([^/]+)$/);
    if (method === 'GET' && teamMatch) {
      return successResponse(requestId, await repo.teams.get(decodeURIComponent(teamMatch[1])));
    }

    if (method === 'GET' && path === '/v1/sessions') {
      return successResponse(requestId, await repo.sessions.list({ limit: parsePositiveLimit(query.limit), cursor: query.cursor || null }));
    }

    const messagesMatch = path.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      return successResponse(requestId, await repo.messages.list({ sessionId: decodeURIComponent(messagesMatch[1]), cursor: query.cursor || null }));
    }

    if (messagesMatch && method === 'POST') {
      return successResponse(requestId, await repo.messages.insert({
        sessionId: decodeURIComponent(messagesMatch[1]),
        input: body,
        idempotencyKey: getHeader(event.headers || {}, 'idempotency-key') || null,
      }));
    }

    if (method === 'POST' && path === '/v1/invites/claim') {
      return successResponse(requestId, await repo.invites.claim({ token: requireField(body, 'token') }));
    }

    return errorResponse(requestId, { code: 'not_found', message: 'Not found' });
  } catch (err) {
    if (err instanceof BusinessApiError) {
      return errorResponse(requestId, err);
    }
    console.error('[business-api] unexpected error', err);
    return errorResponse(requestId, { code: 'internal', message: 'Internal server error' });
  }
}
```

- [ ] **Step 4: Run router tests to verify pass**

Run:

```bash
cd services/fc
npm test -- test/business-api.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fc/lib/business-api.mjs services/fc/test/business-api.test.mjs
git commit -m "feat(fc): add cloud api v1 router"
```

## Task 5: FC Handler Integration

**Files:**
- Modify: `services/fc/index.mjs`
- Test: `services/fc/test/business-api.test.mjs`

- [ ] **Step 1: Add handler integration test**

Append to `services/fc/test/business-api.test.mjs`:

```js
test('handler delegates /v1 requests before legacy routes', async () => {
  const { handler } = await import('../index.mjs');
  const res = await handler({
    rawPath: '/v1/teams',
    requestContext: { http: { method: 'GET' } },
    headers: { authorization: 'Bearer token' },
    queryStringParameters: {},
  });
  assert.notEqual(res.statusCode, 404);
});
```

Expected initial failure: this may fail with a Supabase config error after routing is added, but before integration it should return legacy 405 or 404. Adjust the assertion during implementation to use dependency injection only if importing `index.mjs` initializes external clients.

- [ ] **Step 2: Modify handler to dispatch `/v1`**

In `services/fc/index.mjs`, add import near the existing imports:

```js
import { handleBusinessApi } from './lib/business-api.mjs';
```

Then insert before the legacy `if (httpMethod !== "POST")` block:

```js
  if (path?.startsWith('/v1/')) {
    return await handleBusinessApi(event);
  }
```

Keep the legacy `POST`-only behavior for old routes.

- [ ] **Step 3: Run FC tests**

Run:

```bash
cd services/fc
npm test
```

Expected: PASS for all existing push/APNs tests plus new Cloud API tests.

- [ ] **Step 4: Commit**

```bash
git add services/fc/index.mjs services/fc/test/business-api.test.mjs
git commit -m "feat(fc): route v1 cloud api requests"
```

## Task 6: Repository Contract Fixtures

**Files:**
- Create: `services/fc/lib/repository-contract.mjs`
- Create: `services/fc/test/repository-contract.test.mjs`
- Create: `services/fc/test/fixtures/v1/teams-list.json`
- Create: `services/fc/test/fixtures/v1/sessions-list.json`
- Create: `services/fc/test/fixtures/v1/messages-list.json`
- Create: `services/fc/test/fixtures/v1/message-insert.json`
- Create: `services/fc/test/fixtures/v1/invite-claim.json`

- [ ] **Step 1: Add golden fixtures**

Create `services/fc/test/fixtures/v1/teams-list.json`:

```json
{
  "items": [
    {
      "id": "team-1",
      "name": "Team One",
      "slug": "team-one",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ],
  "nextCursor": null
}
```

Create `services/fc/test/fixtures/v1/sessions-list.json`:

```json
{
  "items": [
    {
      "id": "session-1",
      "teamId": "team-1",
      "title": "Hello",
      "mode": "collab",
      "ideaId": null,
      "lastMessageAt": "2026-01-01T00:00:00Z",
      "lastMessagePreview": "hi",
      "hasUnread": false,
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:00:00Z"
    }
  ],
  "nextCursor": null
}
```

Create `services/fc/test/fixtures/v1/messages-list.json`:

```json
{
  "items": [
    {
      "id": "message-1",
      "teamId": "team-1",
      "sessionId": "session-1",
      "turnId": null,
      "senderActorId": "actor-1",
      "replyToMessageId": null,
      "kind": "text",
      "content": "hello",
      "metadata": null,
      "model": null,
      "createdAt": "2026-01-01T00:00:00Z",
      "updatedAt": null
    }
  ],
  "nextCursor": null
}
```

Create `services/fc/test/fixtures/v1/message-insert.json`:

```json
{
  "id": "message-1",
  "teamId": "team-1",
  "sessionId": "session-1",
  "turnId": null,
  "senderActorId": "actor-1",
  "replyToMessageId": null,
  "kind": "text",
  "content": "hello",
  "metadata": null,
  "model": null,
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": null
}
```

Create `services/fc/test/fixtures/v1/invite-claim.json`:

```json
{
  "actorId": "actor-1",
  "teamId": "team-1",
  "actorType": "member",
  "displayName": "Matt",
  "refreshToken": null
}
```

- [ ] **Step 2: Add contract runner**

Create `services/fc/lib/repository-contract.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function fixture(name) {
  const file = path.resolve('test/fixtures/v1', `${name}.json`);
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function runRepositoryContract(repo) {
  assert.deepEqual(await repo.teams.list({ limit: 50 }), await fixture('teams-list'));
  assert.deepEqual(await repo.sessions.list({ limit: 50, cursor: null }), await fixture('sessions-list'));
  assert.deepEqual(await repo.messages.list({ sessionId: 'session-1', cursor: null }), await fixture('messages-list'));
  assert.deepEqual(
    await repo.messages.insert({
      sessionId: 'session-1',
      idempotencyKey: 'message-1',
      input: { id: 'message-1', teamId: 'team-1', senderActorId: 'actor-1', content: 'hello' },
    }),
    await fixture('message-insert'),
  );
  assert.deepEqual(await repo.invites.claim({ token: 'invite-token' }), await fixture('invite-claim'));
}
```

- [ ] **Step 3: Add fake repository contract test**

Create `services/fc/test/repository-contract.test.mjs`:

```js
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runRepositoryContract } from '../lib/repository-contract.mjs';
import { createSupabaseRepository } from '../lib/supabase-repo.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(path.resolve('test/fixtures/v1', `${name}.json`), 'utf8'));
}

test('repository contract passes against fake repository', async () => {
  const repo = {
    teams: { list: async () => fixture('teams-list') },
    sessions: { list: async () => fixture('sessions-list') },
    messages: {
      list: async () => fixture('messages-list'),
      insert: async () => fixture('message-insert'),
    },
    invites: { claim: async () => fixture('invite-claim') },
  };
  await runRepositoryContract(repo);
});

test('repository contract passes against SupabaseRepository mocked transport', async () => {
  const repo = createSupabaseRepository({
    client: {
      from(table) {
        if (table === 'teams') {
          return {
            select() {
              return {
                order() {
                  return {
                    limit: async () => ({
                      data: [{ id: 'team-1', name: 'Team One', slug: 'team-one', created_at: '2026-01-01T00:00:00Z' }],
                      error: null,
                    }),
                  };
                },
                eq() {
                  return {
                    single: async () => ({
                      data: { id: 'team-1', name: 'Team One', slug: 'team-one', created_at: '2026-01-01T00:00:00Z' },
                      error: null,
                    }),
                  };
                },
              };
            },
          };
        }
        if (table === 'messages') {
          const messageRow = {
            id: 'message-1',
            team_id: 'team-1',
            session_id: 'session-1',
            turn_id: null,
            sender_actor_id: 'actor-1',
            reply_to_message_id: null,
            kind: 'text',
            content: 'hello',
            metadata: null,
            model: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: null,
          };
          return {
            select() {
              return {
                eq() {
                  return {
                    order() {
                      return {
                        order: async () => ({ data: [messageRow], error: null }),
                      };
                    },
                  };
                },
              };
            },
            insert() {
              return {
                select() {
                  return {
                    single: async () => ({ data: messageRow, error: null }),
                  };
                },
              };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
      rpc(name) {
        if (name === 'list_current_actor_sessions') {
          return Promise.resolve({
            data: [{
              id: 'session-1',
              team_id: 'team-1',
              title: 'Hello',
              mode: 'collab',
              idea_id: null,
              last_message_at: '2026-01-01T00:00:00Z',
              last_message_preview: 'hi',
              has_unread: false,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            }],
            error: null,
          });
        }
        if (name === 'claim_team_invite') {
          return Promise.resolve({
            data: [{ actor_id: 'actor-1', team_id: 'team-1', actor_type: 'member', display_name: 'Matt', refresh_token: null }],
            error: null,
          });
        }
        throw new Error(`unexpected rpc ${name}`);
      },
    },
  });
  await runRepositoryContract(repo);
});
```

- [ ] **Step 4: Run contract tests**

Run:

```bash
cd services/fc
npm test -- test/repository-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/fc/lib/repository-contract.mjs services/fc/test/repository-contract.test.mjs services/fc/test/fixtures/v1
git commit -m "test(fc): add cloud api repository contract fixtures"
```

## Task 7: Final Verification

**Files:**
- Modify if needed: files changed by previous tasks

- [ ] **Step 1: Run full FC test suite**

Run:

```bash
cd services/fc
npm test
```

Expected: PASS.

- [ ] **Step 2: Run OpenAPI checks**

Run:

```bash
cd services/fc
npm run openapi:lint
npm run openapi:types
```

Expected: PASS.

- [ ] **Step 3: Confirm scope guardrails**

Run:

```bash
git diff --name-only origin/main...HEAD
```

Expected changed paths are limited to:

```text
docs/openapi/teamclaw-api.v1.yaml
docs/superpowers/plans/2026-05-27-fc-openapi-supabase-proxy.md
docs/superpowers/specs/2026-05-27-fc-openapi-supabase-proxy-design.md
services/fc/**
```

- [ ] **Step 4: Commit final fixes**

If Step 1 or Step 2 required fixes:

```bash
git add services/fc docs/openapi/teamclaw-api.v1.yaml
git commit -m "fix(fc): stabilize cloud api phase 1"
```

If no fixes were needed, do not create an empty commit.

## Self-Review Checklist

- [ ] Phase 1 implements only OpenAPI, FC `/v1`, Supabase token passthrough, and tests.
- [ ] No Web or Android migration code is added.
- [ ] No MySQL code, schema, config, or package is added.
- [ ] No Supabase Storage or Realtime behavior is changed.
- [ ] `/v1` endpoints are domain routes, not generic Supabase proxy routes.
- [ ] Every `/v1` response includes `X-Request-Id`.
- [ ] Missing bearer token returns `missing_auth`.
- [ ] `Idempotency-Key` for message insert must match message id.
- [ ] Contract fixtures exist for every implemented endpoint.
