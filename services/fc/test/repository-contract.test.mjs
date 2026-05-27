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
  const messageStore = fixture("message-list.json").items.slice();
  return {
    async listSessions() {
      return fixture("session-list.json").items;
    },
    async listMessages(sessionId) {
      assert.equal(sessionId, "session-1");
      return messageStore;
    },
    async insertMessage(_sessionId, input) {
      if (input.id === "duplicate-message") {
        throw { code: "23505", message: "duplicate key value violates unique constraint" };
      }
      const msg = {
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
      messageStore.push(msg);
      return msg;
    },
    async patchMessage(messageId, patch) {
      const msg = messageStore.find(m => m.id === messageId);
      if (!msg) return null;
      if (patch.content !== undefined) msg.content = patch.content;
      if (patch.metadata !== undefined) msg.metadata = patch.metadata;
      msg.updatedAt = "2026-05-27T02:00:00Z";
      return msg;
    },
    async deleteMessage(messageId) {
      const idx = messageStore.findIndex(m => m.id === messageId);
      if (idx >= 0) messageStore.splice(idx, 1);
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
    async getTeamDirectory(teamId) {
      assert.equal(teamId, "team-1");
      return {
        actors: [
          {
            id: "actor-1",
            teamId: "team-1",
            kind: "user",
            displayName: "Alice",
            avatarUrl: null,
            metadata: null,
          },
          {
            id: "actor-2",
            teamId: "team-1",
            kind: "agent",
            displayName: "Bot",
            avatarUrl: "https://example.com/avatar.png",
            metadata: { type: "assistant" },
          },
        ],
        members: [
          {
            actorId: "actor-1",
            teamId: "team-1",
            role: "member",
            joinedAt: "2026-05-27T01:00:00Z",
          },
          {
            actorId: "actor-2",
            teamId: "team-1",
            role: "admin",
            joinedAt: "2026-05-27T02:00:00Z",
          },
        ],
      };
    },
    async listTeamActors(teamId, { kind, limit }) {
      assert.equal(teamId, "team-1");
      return {
        items: [
          { id: "actor-1", teamId: "team-1", kind: "user", displayName: "Test Actor", avatarUrl: null, metadata: null },
          { id: "actor-2", teamId: "team-1", kind: "agent", displayName: "Test Agent", avatarUrl: null, metadata: null },
        ],
      };
    },
    async getActor(actorId) {
      if (actorId === "actor-missing") return null;
      return { id: actorId, teamId: "team-1", kind: "user", displayName: "Test Actor", avatarUrl: null, metadata: null };
    },
    async upsertExternalActor(input) {
      assert.equal(input.teamId, "team-1");
      return { actorId: "actor-new" };
    },
    async listConnectedAgents(teamId) {
      assert.equal(teamId, "team-1");
      return {
        items: [
          { id: "agent-1", teamId: "team-1", kind: "agent", displayName: "Test Agent", avatarUrl: null, metadata: null, deviceId: "device-1", lastSeenAt: "2026-05-27T01:00:00Z", agentType: "claude" },
        ],
      };
    },
    async updateOwnedAgentProfile(agentActorId, patch) {
      assert.equal(agentActorId, "agent-1");
    },
    async updateAgentDefaults(agentActorId, patch) {
      assert.equal(agentActorId, "agent-1");
    },
    async checkAgentPermission(agentActorId, actorId) {
      assert.equal(agentActorId, "agent-1");
      if (actorId === "actor-no-access") return { allowed: false, role: null };
      return { allowed: true, role: "admin" };
    },
    async listAgentAccess(agentActorId) {
      assert.equal(agentActorId, "agent-1");
      return {
        items: [
          { agentActorId: "agent-1", actorId: "actor-1", role: "admin" },
        ],
      };
    },
    async grantAgentAccess(agentActorId, { actorId, role }) {
      assert.equal(agentActorId, "agent-1");
      return { agentActorId, actorId, role };
    },
    async revokeAgentAccess(agentActorId, actorId) {
      assert.equal(agentActorId, "agent-1");
    },
    async listAgentAdminMembers(agentActorId) {
      assert.equal(agentActorId, "agent-1");
      return { items: ["actor-1"] };
    },
  };
}

function fixture(name) {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "v1", name), "utf8"));
}
