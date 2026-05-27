import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCursor,
  encodeCursor,
  handleBusinessApiRequest,
} from "../lib/business-api.mjs";

test("handleBusinessApiRequest routes list sessions with bearer-scoped repository", async () => {
  const repo = fakeRepo({
    sessions: [
      session("s1", "2026-05-27T01:00:00Z"),
      session("s2", "2026-05-27T00:00:00Z"),
    ],
  });
  const createCalls = [];

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: {
      Authorization: "Bearer caller-token",
      "X-Request-Id": "request_12345",
    },
    queryStringParameters: { limit: "2" },
  }, {
    createRepository(args) {
      createCalls.push(args);
      return repo;
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["X-Request-Id"], "request_12345");
  assert.deepEqual(createCalls, [{ accessToken: "caller-token" }]);
  const body = JSON.parse(response.body);
  assert.equal(body.items.length, 2);
  assert.deepEqual(decodeCursor(body.nextCursor), {
    lastMessageAt: "2026-05-27T00:00:00Z",
    createdAt: "2026-05-26T00:00:00Z",
    id: "s2",
  });
  assert.deepEqual(repo.calls[0], {
    method: "listSessions",
    args: {
      limit: 2,
      cursor: null,
    },
  });
});

test("list sessions decodes cursor before calling repository", async () => {
  const repo = fakeRepo({ sessions: [] });
  const cursor = encodeCursor({
    lastMessageAt: "2026-05-27T01:00:00Z",
    createdAt: "2026-05-26T01:00:00Z",
    id: "s1",
  });

  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: { cursor },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0].args.cursor, {
    lastMessageAt: "2026-05-27T01:00:00Z",
    createdAt: "2026-05-26T01:00:00Z",
    id: "s1",
  });
});

test("insert message enforces narrow idempotency contract", async () => {
  const repo = fakeRepo();

  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/messages",
    headers: {
      Authorization: "Bearer token",
      "Idempotency-Key": "different-id",
    },
    body: JSON.stringify({
      id: "message-1",
      teamId: "team-1",
      senderActorId: "actor-1",
      content: "hello",
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
  assert.equal(repo.calls.length, 0);
});

test("insert message calls repository when idempotency key matches message id", async () => {
  const repo = fakeRepo();

  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/messages",
    headers: {
      Authorization: "Bearer token",
      "Idempotency-Key": "message-1",
    },
    body: JSON.stringify({
      id: "message-1",
      teamId: "team-1",
      senderActorId: "actor-1",
      content: "hello",
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], {
    method: "insertMessage",
    sessionId: "session-1",
    input: {
      id: "message-1",
      teamId: "team-1",
      senderActorId: "actor-1",
      content: "hello",
    },
  });
});

test("claim invite maps body token to repository", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/invites/claim",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ token: "invite-token" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], { method: "claimInvite", token: "invite-token" });
});

test("missing bearer returns OpenAPI error envelope", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: {},
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, "missing_auth");
  assert.match(body.error.requestId, /^[A-Za-z0-9_-]+$/);
});

test("repository Supabase errors are normalized", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
  }, {
    createRepository: () => fakeRepo({ error: { code: "23505", message: "duplicate key" } }),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body).error.code, "conflict");
});

function session(id, lastMessageAt) {
  return {
    id,
    teamId: "team-1",
    title: id,
    mode: "collab",
    ideaId: null,
    lastMessageAt,
    lastMessagePreview: null,
    hasUnread: false,
    createdAt: "2026-05-26T00:00:00Z",
    updatedAt: lastMessageAt,
  };
}

function fakeRepo({ sessions = [], error = null } = {}) {
  const calls = [];
  return {
    calls,
    async listTeams(args) {
      calls.push({ method: "listTeams", args });
      if (error) throw error;
      return [];
    },
    async createTeam(input) {
      calls.push({ method: "createTeam", input });
      if (error) throw error;
      return { id: "team-1", name: input.name, slug: input.slug ?? null, createdAt: null };
    },
    async getTeam(teamId) {
      calls.push({ method: "getTeam", teamId });
      if (error) throw error;
      return { id: teamId, name: "Team", slug: null, createdAt: null };
    },
    async listSessions(args) {
      calls.push({ method: "listSessions", args });
      if (error) throw error;
      return sessions;
    },
    async listMessages(sessionId) {
      calls.push({ method: "listMessages", sessionId });
      if (error) throw error;
      return [];
    },
    async insertMessage(sessionId, input) {
      calls.push({ method: "insertMessage", sessionId, input });
      if (error) throw error;
      return {
        id: input.id,
        teamId: input.teamId,
        sessionId,
        turnId: null,
        senderActorId: input.senderActorId,
        replyToMessageId: null,
        kind: input.kind ?? "text",
        content: input.content,
        metadata: input.metadata ?? null,
        model: null,
        createdAt: "2026-05-27T01:00:00Z",
        updatedAt: null,
      };
    },
    async claimInvite(token) {
      calls.push({ method: "claimInvite", token });
      if (error) throw error;
      return {
        actorId: "actor-1",
        teamId: "team-1",
        actorType: "member",
        displayName: "Alice",
        refreshToken: null,
      };
    },
  };
}
