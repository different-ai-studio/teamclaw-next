import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../lib/business-api.mjs";

function makeRepo(overrides = {}) {
  const calls = [];
  const record = (method) => async (...args) => {
    calls.push({ method, args });
    const fn = overrides[method];
    return typeof fn === "function" ? fn(...args) : undefined;
  };
  return {
    calls,
    listSessionsForTeamSince: record("listSessionsForTeamSince"),
    listMessagesForSessionSince: record("listMessagesForSessionSince"),
    listSessionDisplayRows: record("listSessionDisplayRows"),
    listSessionIdsForActor: record("listSessionIdsForActor"),
    listWorkspacesByIdsSlim: record("listWorkspacesByIdsSlim"),
    listShortcutRoleBindings: record("listShortcutRoleBindings"),
  };
}

async function request(repo, { method, path, body, headers = {}, query = {} }) {
  return handleBusinessApiRequest(
    {
      httpMethod: method,
      path,
      headers: { Authorization: "Bearer caller-token", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      queryStringParameters: query,
    },
    {
      createRepository: () => repo,
      createAuthRepository: () => repo,
    },
  );
}

test("GET /v1/sync/sessions forwards teamId+since", async () => {
  const repo = makeRepo({
    listSessionsForTeamSince: () => [{ id: "s1", team_id: "t1" }],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/sessions",
    query: { teamId: "t1", since: "2026-05-01T00:00:00Z" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).items[0].id, "s1");
  assert.deepEqual(repo.calls[0].args, ["t1", "2026-05-01T00:00:00Z"]);
});

test("GET /v1/sync/sessions requires teamId", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/sessions",
    query: {},
  });
  assert.equal(res.statusCode, 400);
});

test("GET /v1/sync/messages forwards sessionId+since", async () => {
  const repo = makeRepo({
    listMessagesForSessionSince: () => [{ id: "m1" }],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/messages",
    query: { sessionId: "s1" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["s1", null]);
});

test("GET /v1/sync/messages requires sessionId", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "GET",
    path: "/v1/sync/messages",
    query: {},
  });
  assert.equal(res.statusCode, 400);
});

test("POST /v1/sessions/display-rows forwards teamId+ids", async () => {
  const repo = makeRepo({
    listSessionDisplayRows: () => [{ id: "s1", title: "Hi" }],
  });
  const res = await request(repo, {
    method: "POST",
    path: "/v1/sessions/display-rows",
    body: { teamId: "t1", sessionIds: ["s1", "s2"] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["t1", ["s1", "s2"]]);
});

test("POST /v1/sessions/display-rows rejects non-array sessionIds", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/sessions/display-rows",
    body: { teamId: "t1", sessionIds: "nope" },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /v1/actors/:actorId/sessions returns ids", async () => {
  const repo = makeRepo({
    listSessionIdsForActor: () => ["s1", "s2"],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/actors/actor-1/sessions",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { items: ["s1", "s2"] });
  assert.deepEqual(repo.calls[0].args, ["actor-1"]);
});

test("POST /v1/workspaces/by-ids forwards teamId+ids", async () => {
  const repo = makeRepo({
    listWorkspacesByIdsSlim: () => [{ id: "w1", name: "Alpha", path: "/x" }],
  });
  const res = await request(repo, {
    method: "POST",
    path: "/v1/workspaces/by-ids",
    body: { teamId: "t1", ids: ["w1"] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["t1", ["w1"]]);
});

test("POST /v1/workspaces/by-ids rejects non-array ids", async () => {
  const repo = makeRepo();
  const res = await request(repo, {
    method: "POST",
    path: "/v1/workspaces/by-ids",
    body: { teamId: "t1", ids: "no" },
  });
  assert.equal(res.statusCode, 400);
});

test("GET /v1/teams/:teamId/shortcut-role-bindings returns items", async () => {
  const repo = makeRepo({
    listShortcutRoleBindings: () => [
      { resource_id: "sc1", permission_roles: [{ role_id: "r1" }] },
    ],
  });
  const res = await request(repo, {
    method: "GET",
    path: "/v1/teams/team-1/shortcut-role-bindings",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.calls[0].args, ["team-1"]);
  assert.equal(JSON.parse(res.body).items[0].resource_id, "sc1");
});
