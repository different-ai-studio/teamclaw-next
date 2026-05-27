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

test("PATCH /v1/messages/:messageId updates message", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/messages/message-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ content: "updated content" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.content, "updated content");
  assert.deepEqual(repo.calls[0], {
    method: "patchMessage",
    messageId: "message-1",
    patch: { content: "updated content" },
  });
});

test("DELETE /v1/messages/:messageId removes message", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/messages/message-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], {
    method: "deleteMessage",
    messageId: "message-1",
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

test("POST /v1/auth/refresh proxies to repository without auth", async () => {
  const authCalls = [];
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/refresh",
    headers: {},
    body: JSON.stringify({ refreshToken: "test-rt" }),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository() {
      return {
        async refreshAccessToken({ refreshToken }) {
          authCalls.push({ refreshToken });
          return { accessToken: "at-2", refreshToken: "rt-2", expiresAt: 123 };
        },
      };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(authCalls, [{ refreshToken: "test-rt" }]);
  assert.deepEqual(JSON.parse(response.body), { accessToken: "at-2", refreshToken: "rt-2", expiresAt: 123 });
});

test("POST /v1/auth/refresh rejects missing refreshToken", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/auth/refresh",
    headers: {},
    body: JSON.stringify({}),
  }, {
    createRepository: () => fakeRepo(),
    createAuthRepository: () => ({
      async refreshAccessToken() { throw new Error("should not be called"); },
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
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

test("GET /v1/teams/:teamId/workspace-config returns 404 when not set", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/workspace-config",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
  assert.deepEqual(repo.calls[0], { method: "getTeamWorkspaceConfig", teamId: "team-1" });
});

test("GET /v1/teams/:teamId/workspace-config returns config when set", async () => {
  const repo = fakeRepo({
    teamWorkspaceConfigs: {
      "team-1": {
        teamId: "team-1",
        defaultWorkspaceId: "workspace-1",
        pinnedWorkspaceIds: [],
        updatedAt: "2026-05-27T01:00:00Z",
      },
    },
  });
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/workspace-config",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.defaultWorkspaceId, "workspace-1");
});

test("PUT /v1/teams/:teamId/workspace-config upserts config", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PUT",
    path: "/v1/teams/team-1/workspace-config",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({
      defaultWorkspaceId: "workspace-2",
      pinnedWorkspaceIds: ["workspace-3"],
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.defaultWorkspaceId, "workspace-2");
  assert.deepEqual(body.pinnedWorkspaceIds, ["workspace-3"]);
  assert.deepEqual(repo.calls[0], {
    method: "putTeamWorkspaceConfig",
    teamId: "team-1",
    input: {
      defaultWorkspaceId: "workspace-2",
      pinnedWorkspaceIds: ["workspace-3"],
    },
  });
});

test("POST /v1/heartbeat calls repository.heartbeat", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/heartbeat",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "heartbeat" });
});

test("GET /v1/workspaces returns 400 without teamId", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("GET /v1/workspaces returns workspace page", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces",
    headers: { Authorization: "Bearer token" },
    queryStringParameters: { teamId: "team-1" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].name, "Alpha");
  assert.deepEqual(repo.calls[0], {
    method: "listWorkspaces",
    args: { teamId: "team-1", limit: 50, cursor: null },
  });
});

test("POST /v1/workspaces upserts workspace", async () => {
  const repo = fakeRepo({ workspaces: [] });
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/workspaces",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({
      id: "workspace-2",
      teamId: "team-1",
      name: "Beta",
    }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.id, "workspace-2");
  assert.equal(body.name, "Beta");
  assert.deepEqual(repo.calls[0], {
    method: "upsertWorkspace",
    input: {
      id: "workspace-2",
      teamId: "team-1",
      name: "Beta",
      slug: null,
      archived: false,
      metadata: null,
    },
  });
});

test("GET /v1/workspaces/:workspaceId returns 404 for missing workspace", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces/workspace-missing",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo({ workspaces: [] }) });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("GET /v1/workspaces/:workspaceId returns workspace", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/workspaces/workspace-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.name, "Alpha");
  assert.deepEqual(repo.calls[0], { method: "getWorkspace", workspaceId: "workspace-1" });
});

test("PATCH /v1/workspaces/:workspaceId updates workspace", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/workspaces/workspace-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ archived: true }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.archived, true);
  assert.deepEqual(repo.calls[0], {
    method: "patchWorkspace",
    workspaceId: "workspace-1",
    patch: { archived: true },
  });
});

test("GET /v1/teams/:teamId/directory returns actors and members", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/teams/team-1/directory",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.actors));
  assert.ok(Array.isArray(body.members));
  assert.equal(body.actors.length, 1);
  assert.equal(body.actors[0].displayName, "Alice");
  assert.equal(body.members.length, 1);
  assert.equal(body.members[0].role, "member");
  assert.deepEqual(repo.calls[0], { method: "getTeamDirectory", teamId: "team-1" });
});

test("GET /v1/sessions/:sessionId returns session with participants", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.id, "session-1");
  assert.ok(Array.isArray(body.participants));
  assert.deepEqual(repo.calls[0], { method: "getSession", sessionId: "session-1" });
});

test("GET /v1/sessions/:sessionId returns 404 for missing session", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-missing",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo({ sessions: [] }) });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("PATCH /v1/sessions/:sessionId updates session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "PATCH",
    path: "/v1/sessions/session-1",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ title: "New title" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.title, "New title");
  assert.deepEqual(repo.calls[0], { method: "patchSession", sessionId: "session-1", patch: { title: "New title" } });
});

test("POST /v1/sessions creates session", async () => {
  const repo = fakeRepo({ sessions: [] });
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1", title: "New", mode: "solo" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(repo.calls[0], { method: "createSession", input: { teamId: "team-1", title: "New", mode: "solo" } });
});

test("POST /v1/sessions returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("POST /v1/sessions/:sessionId/mark-viewed returns 204", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/mark-viewed",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "markSessionViewed", sessionId: "session-1" });
});

test("GET /v1/sessions/:sessionId/participants returns participant list", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/participants",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.items));
  assert.deepEqual(repo.calls[0], { method: "listSessionParticipants", sessionId: "session-1" });
});

test("POST /v1/sessions/:sessionId/participants upserts participant", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/participants",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ actorId: "actor-2", role: "member" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(repo.calls[0], { method: "upsertSessionParticipant", sessionId: "session-1", input: { actorId: "actor-2", role: "member" } });
});

test("POST /v1/sessions/:sessionId/participants returns 400 without actorId", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/session-1/participants",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ role: "member" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("DELETE /v1/sessions/:sessionId/participants/:actorId removes participant", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "DELETE",
    path: "/v1/sessions/session-1/participants/actor-1",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 204);
  assert.deepEqual(repo.calls[0], { method: "removeSessionParticipant", sessionId: "session-1", actorId: "actor-1" });
});

test("GET /v1/sessions/by-acp/:acpSessionId returns 404 when not found", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/by-acp/acp-missing",
    headers: { Authorization: "Bearer token" },
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "not_found");
});

test("POST /v1/sessions/gateway/ensure creates gateway session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/gateway/ensure",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1", binding: "wecom:room#1", title: "Stand-up", primaryAgentActorId: "actor-1", ownerMemberActorIds: [], participantActorIds: [] }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(body.sessionId);
  assert.equal(body.created, true);
  assert.deepEqual(repo.calls[0], { method: "ensureGatewaySession", input: { teamId: "team-1", binding: "wecom:room#1", title: "Stand-up", primaryAgentActorId: "actor-1", ownerMemberActorIds: [], participantActorIds: [] } });
});

test("POST /v1/sessions/gateway/ensure returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/gateway/ensure",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
});

test("POST /v1/sessions/cron creates cron session", async () => {
  const repo = fakeRepo();
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/cron",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1", primaryAgentActorId: "actor-1", title: "Daily" }),
  }, { createRepository: () => repo });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(body.sessionId);
  assert.deepEqual(repo.calls[0], { method: "createCronSession", input: { teamId: "team-1", primaryAgentActorId: "actor-1", title: "Daily" } });
});

test("POST /v1/sessions/cron returns 400 without required fields", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/sessions/cron",
    headers: { Authorization: "Bearer token" },
    body: JSON.stringify({ teamId: "team-1" }),
  }, { createRepository: () => fakeRepo() });

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "validation_failed");
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

function fakeRepo({ sessions = [], error = null, teamWorkspaceConfigs = {}, workspaces = [] } = {}) {
  const calls = [];
  const configs = { ...teamWorkspaceConfigs };
  const workspaceStore = workspaces.length > 0 ? workspaces.slice() : [
    { id: "workspace-1", teamId: "team-1", name: "Alpha", slug: null, archived: false, metadata: null, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  const sessionStore = sessions.length > 0 ? sessions.slice() : [
    { id: "session-1", teamId: "team-1", title: "Architecture plan", mode: "collab", ideaId: "idea-1", lastMessageAt: "2026-05-27T00:30:00Z", lastMessagePreview: "Start with OpenAPI.", hasUnread: false, createdAt: "2026-05-26T23:00:00Z", updatedAt: "2026-05-27T00:30:00Z", participants: [{ sessionId: "session-1", actorId: "actor-1", role: "owner", joinedAt: "2026-05-26T23:00:00Z" }] },
    { id: "session-2", teamId: "team-1", title: "Migration review", mode: "collab", ideaId: null, lastMessageAt: "2026-05-27T02:00:00Z", lastMessagePreview: "FC facade is the next boundary.", hasUnread: true, createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T02:00:00Z", participants: [] },
  ];
  const gatewayBindings = {};
  return {
    calls,
    async listTeams(args) { calls.push({ method: "listTeams", args }); if (error) throw error; return []; },
    async createTeam(input) { calls.push({ method: "createTeam", input }); if (error) throw error; return { id: "team-1", name: input.name, slug: input.slug ?? null, createdAt: null }; },
    async getTeam(teamId) { calls.push({ method: "getTeam", teamId }); if (error) throw error; return { id: teamId, name: "Team", slug: null, createdAt: null }; },
    async listSessions(args) { calls.push({ method: "listSessions", args }); if (error) throw error; return sessions.length > 0 ? sessions : sessionStore; },
    async getSession(sessionId) { calls.push({ method: "getSession", sessionId }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; return store.find(s => s.id === sessionId) ?? null; },
    async patchSession(sessionId, patch) { calls.push({ method: "patchSession", sessionId, patch }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); if (!s) return null; if (patch.title !== undefined) s.title = patch.title; return s; },
    async createSession(input) { calls.push({ method: "createSession", input }); if (error) throw error; const id = input.id ?? "session-new"; const newS = { id, teamId: input.teamId, title: input.title, mode: input.mode, ideaId: null, lastMessageAt: null, lastMessagePreview: null, hasUnread: false, createdAt: "2026-05-27T03:00:00Z", updatedAt: "2026-05-27T03:00:00Z", participants: (input.participantActorIds ?? []).map(a => ({ sessionId: id, actorId: a, role: "member", joinedAt: null })) }; sessionStore.push(newS); return newS; },
    async markSessionViewed(sessionId) { calls.push({ method: "markSessionViewed", sessionId }); if (error) throw error; },
    async listSessionParticipants(sessionId) { calls.push({ method: "listSessionParticipants", sessionId }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); return { items: s?.participants ?? [] }; },
    async upsertSessionParticipant(sessionId, input) { calls.push({ method: "upsertSessionParticipant", sessionId, input }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); const existing = s?.participants?.find(p => p.actorId === input.actorId); if (existing) { existing.role = input.role ?? existing.role; return existing; } const newP = { sessionId, actorId: input.actorId, role: input.role ?? "member", joinedAt: null }; if (s) s.participants.push(newP); return newP; },
    async removeSessionParticipant(sessionId, actorId) { calls.push({ method: "removeSessionParticipant", sessionId, actorId }); if (error) throw error; const store = sessions.length > 0 ? sessions : sessionStore; const s = store.find(s => s.id === sessionId); if (s?.participants) s.participants = s.participants.filter(p => p.actorId !== actorId); },
    async getSessionByAcp(acpSessionId) { calls.push({ method: "getSessionByAcp", acpSessionId }); if (error) throw error; return gatewayBindings[acpSessionId] ?? null; },
    async ensureGatewaySession(input) { calls.push({ method: "ensureGatewaySession", input }); if (error) throw error; const b = input.binding; if (gatewayBindings[b]) return { ...gatewayBindings[b], created: false }; const r = { sessionId: "gw-" + b, gatewaySessionId: b, created: true }; gatewayBindings[b] = r; return r; },
    async createCronSession(input) { calls.push({ method: "createCronSession", input }); if (error) throw error; return { sessionId: "cron-" + input.title }; },
    async listMessages(sessionId) { calls.push({ method: "listMessages", sessionId }); if (error) throw error; return []; },
    async insertMessage(sessionId, input) { calls.push({ method: "insertMessage", sessionId, input }); if (error) throw error; return { id: input.id, teamId: input.teamId, sessionId, turnId: null, senderActorId: input.senderActorId, replyToMessageId: null, kind: input.kind ?? "text", content: input.content, metadata: input.metadata ?? null, model: null, createdAt: "2026-05-27T01:00:00Z", updatedAt: null }; },
    async patchMessage(messageId, patch) { calls.push({ method: "patchMessage", messageId, patch }); if (error) throw error; return { id: messageId, teamId: "team-1", sessionId: "session-1", turnId: null, senderActorId: "actor-1", replyToMessageId: null, kind: "text", content: patch.content ?? "hello", metadata: patch.metadata ?? null, model: null, createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T02:00:00Z" }; },
    async deleteMessage(messageId) { calls.push({ method: "deleteMessage", messageId }); if (error) throw error; },
    async claimInvite(token) { calls.push({ method: "claimInvite", token }); if (error) throw error; return { actorId: "actor-1", teamId: "team-1", actorType: "member", displayName: "Alice", refreshToken: null }; },
    async getTeamWorkspaceConfig(teamId) { calls.push({ method: "getTeamWorkspaceConfig", teamId }); if (error) throw error; return configs[teamId] ?? null; },
    async putTeamWorkspaceConfig(teamId, input) { calls.push({ method: "putTeamWorkspaceConfig", teamId, input }); if (error) throw error; configs[teamId] = { teamId, defaultWorkspaceId: input.defaultWorkspaceId ?? null, pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [], updatedAt: "2026-05-27T01:00:00Z" }; return configs[teamId]; },
    async heartbeat() { calls.push({ method: "heartbeat" }); if (error) throw error; },
    async listWorkspaces(args) { calls.push({ method: "listWorkspaces", args }); if (error) throw error; return { items: workspaceStore }; },
    async upsertWorkspace(input) { calls.push({ method: "upsertWorkspace", input }); if (error) throw error; const existing = workspaceStore.find(w => w.id === input.id); if (existing) { Object.assign(existing, input); return existing; } const newW = { id: input.id ?? "workspace-new", teamId: input.teamId, name: input.name, slug: input.slug ?? null, archived: input.archived ?? false, metadata: input.metadata ?? null, createdAt: "2026-05-27T01:00:00Z", updatedAt: "2026-05-27T01:00:00Z" }; workspaceStore.push(newW); return newW; },
    async getWorkspace(workspaceId) { calls.push({ method: "getWorkspace", workspaceId }); if (error) throw error; return workspaceStore.find(w => w.id === workspaceId) ?? null; },
    async patchWorkspace(workspaceId, patch) { calls.push({ method: "patchWorkspace", workspaceId, patch }); if (error) throw error; const w = workspaceStore.find(w => w.id === workspaceId); if (!w) return null; if (patch.name !== undefined) w.name = patch.name; if (patch.archived !== undefined) w.archived = patch.archived; return w; },
    async getTeamDirectory(teamId) { calls.push({ method: "getTeamDirectory", teamId }); if (error) throw error; return { actors: [{ id: "actor-1", teamId: "team-1", kind: "user", displayName: "Alice", avatarUrl: null, metadata: null }], members: [{ actorId: "actor-1", teamId: "team-1", role: "member", joinedAt: "2026-05-27T01:00:00Z" }] }; },
  };
}
