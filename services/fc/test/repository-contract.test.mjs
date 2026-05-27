import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleBusinessApiRequest } from "../lib/business-api.mjs";
import { runBusinessRepositoryContract } from "../lib/repository-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

runBusinessRepositoryContract({
  test,
  assert,
  createRepository: () => contractRepo(),
});

test("golden response: GET /v1/sessions", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions",
    headers: {
      Authorization: "Bearer contract-token",
      "X-Request-Id": "contract_req_1",
    },
  }, { createRepository: () => contractRepo() });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), fixture("session-list.json"));
});

test("golden response: GET /v1/sessions/{id}/messages", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/sessions/session-1/messages",
    headers: {
      Authorization: "Bearer contract-token",
      "X-Request-Id": "contract_req_2",
    },
  }, { createRepository: () => contractRepo() });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), fixture("message-list.json"));
});

function contractRepo() {
  const workspaceStore = [
    { id: "workspace-1", teamId: "team-1", name: "Alpha", slug: null, archived: false, metadata: null, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  const configStore = {};
  return {
    async listSessions() {
      return fixture("session-list.json").items;
    },
    async listMessages(sessionId) {
      assert.equal(sessionId, "session-1");
      return fixture("message-list.json").items;
    },
    async insertMessage(_sessionId, input) {
      if (input.id === "duplicate-message") {
        throw { code: "23505", message: "duplicate key value violates unique constraint" };
      }
      return {
        id: input.id,
        teamId: input.teamId,
        sessionId: "session-1",
        turnId: input.turnId ?? null,
        senderActorId: input.senderActorId,
        replyToMessageId: input.replyToMessageId ?? null,
        kind: input.kind ?? "text",
        content: input.content,
        metadata: input.metadata ?? null,
        model: input.model ?? null,
        createdAt: input.createdAt ?? "2026-05-27T01:00:00Z",
        updatedAt: null,
      };
    },
    async listWorkspaces(args) {
      assert.equal(args.teamId, "team-1");
      return { items: workspaceStore };
    },
    async upsertWorkspace(input) {
      const existing = workspaceStore.find(w => w.id === input.id);
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      const newW = {
        id: input.id ?? "workspace-new",
        teamId: input.teamId,
        name: input.name,
        slug: input.slug ?? null,
        archived: input.archived ?? false,
        metadata: input.metadata ?? null,
        createdAt: "2026-05-27T01:00:00Z",
        updatedAt: "2026-05-27T01:00:00Z",
      };
      workspaceStore.push(newW);
      return newW;
    },
    async getWorkspace(workspaceId) {
      return workspaceStore.find(w => w.id === workspaceId) ?? null;
    },
    async patchWorkspace(workspaceId, patch) {
      const w = workspaceStore.find(w => w.id === workspaceId);
      if (!w) return null;
      if (patch.name !== undefined) w.name = patch.name;
      if (patch.archived !== undefined) w.archived = patch.archived;
      if (patch.metadata !== undefined) w.metadata = patch.metadata;
      return w;
    },
    async getTeamWorkspaceConfig(teamId) {
      return configStore[teamId] ?? null;
    },
    async putTeamWorkspaceConfig(teamId, input) {
      configStore[teamId] = {
        teamId,
        defaultWorkspaceId: input.defaultWorkspaceId ?? null,
        pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [],
        updatedAt: "2026-05-27T01:00:00Z",
      };
      return configStore[teamId];
    },
  };
}

function fixture(name) {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "v1", name), "utf8"));
}
