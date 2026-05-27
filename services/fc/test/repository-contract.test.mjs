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

test("golden response: GET /v1/ideas", async () => {
  const response = await handleBusinessApiRequest({
    httpMethod: "GET",
    path: "/v1/ideas",
    headers: {
      Authorization: "Bearer contract-token",
      "X-Request-Id": "contract_req_ideas",
    },
    queryStringParameters: { teamId: "team-1" },
  }, { createRepository: () => contractRepo() });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), fixture("ideas-list.json"));
});

function contractRepo() {
  const shortcutStore = [
    { id: "shortcut-1", teamId: "team-1", parentId: null, kind: "link", label: "Home", payload: null, position: 0, visibleRoleIds: [], createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  const roleStore = [
    { id: "role-1", teamId: "team-1", code: "admin", name: "Admin" },
  ];
  const permissionStore = [
    { resourceId: "resource-1", roleIds: ["role-1"] },
  ];
  const workspaceStore = [
    { id: "workspace-1", teamId: "team-1", name: "Alpha", slug: null, archived: false, metadata: null, createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-05-01T00:00:00Z" },
  ];
  const ideaStore = fixture("ideas-list.json").items.slice();
  const configStore = {};
  const messageStore = fixture("message-list.json").items.slice();
  const sessionStore = fixture("session-list.json").items.slice().map(s => ({ ...s, participants: [{ sessionId: s.id, actorId: "actor-1", role: "owner", joinedAt: s.createdAt }] }));
  const gatewayBindings = {};
  return {
    async listSessions() {
      return fixture("session-list.json").items;
    },
    async getSession(sessionId) {
      return sessionStore.find(s => s.id === sessionId) ?? null;
    },
    async patchSession(sessionId, patch) {
      const s = sessionStore.find(s => s.id === sessionId);
      if (!s) return null;
      if (patch.title !== undefined) s.title = patch.title;
      return s;
    },
    async createSession(input) {
      const id = input.id ?? "session-new";
      const newS = { id, teamId: input.teamId, title: input.title, mode: input.mode, ideaId: null, lastMessageAt: null, lastMessagePreview: null, hasUnread: false, createdAt: "2026-05-27T03:00:00Z", updatedAt: "2026-05-27T03:00:00Z", participants: (input.participantActorIds ?? []).map(a => ({ sessionId: id, actorId: a, role: "member", joinedAt: null })) };
      sessionStore.push(newS);
      return newS;
    },
    async markSessionViewed(sessionId) {},
    async listSessionParticipants(sessionId) {
      const s = sessionStore.find(s => s.id === sessionId);
      return { items: s?.participants ?? [] };
    },
    async upsertSessionParticipant(sessionId, input) {
      const s = sessionStore.find(s => s.id === sessionId);
      const existing = s?.participants?.find(p => p.actorId === input.actorId);
      if (existing) { existing.role = input.role ?? existing.role; return existing; }
      const newP = { sessionId, actorId: input.actorId, role: input.role ?? "member", joinedAt: null };
      if (s) s.participants.push(newP);
      return newP;
    },
    async removeSessionParticipant(sessionId, actorId) {
      const s = sessionStore.find(s => s.id === sessionId);
      if (s?.participants) s.participants = s.participants.filter(p => p.actorId !== actorId);
    },
    async getSessionByAcp(acpSessionId) {
      return gatewayBindings[acpSessionId] ?? null;
    },
    async ensureGatewaySession(input) {
      const b = input.binding;
      if (gatewayBindings[b]) return { ...gatewayBindings[b], created: false };
      const r = { sessionId: "gw-" + b, gatewaySessionId: b, created: true };
      gatewayBindings[b] = r;
      return r;
    },
    async createCronSession(input) {
      return { sessionId: "cron-" + input.title };
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
    async getNotificationPrefs() {
      return { userId: null, pushEnabled: true, emailEnabled: false, digestFrequency: "off" };
    },
    async putNotificationPrefs(input) {
      return {
        userId: input.userId ?? "user-1",
        pushEnabled: input.pushEnabled ?? true,
        emailEnabled: input.emailEnabled ?? false,
        digestFrequency: input.digestFrequency ?? "off",
      };
    },
    async muteSession(sessionId, input) {},
    async unmuteSession(sessionId) {},
    async listMutedSessions() {
      return { items: [] };
    },
    async renameTeam(teamId, input) {
      assert.equal(teamId, "team-1");
      return { id: teamId, name: input.name, slug: null, createdAt: null };
    },
    async createTeamInvite(teamId, input) {
      assert.equal(teamId, "team-1");
      return { token: "invite-token", inviteId: "invite-1", expiresAt: input.expiresAt ?? null };
    },
    async removeTeamActor(teamId, actorId) {
      assert.equal(teamId, "team-1");
    },
    async listIdeas({ teamId, archived, limit, cursor }) {
      assert.equal(teamId, "team-1");
      return { items: ideaStore };
    },
    async getIdea(ideaId) {
      return ideaStore.find(i => i.id === ideaId) ?? null;
    },
    async createIdea(body) {
      const idea = {
        id: body.id ?? "idea-new",
        teamId: body.teamId,
        title: body.title,
        description: body.description ?? null,
        archived: false,
        authorActorId: body.authorActorId,
        actorIds: body.actorIds ?? [],
        createdAt: "2026-05-27T01:00:00Z",
        updatedAt: "2026-05-27T01:00:00Z",
      };
      ideaStore.push(idea);
      return idea;
    },
    async updateIdea(ideaId, patch) {
      const i = ideaStore.find(i => i.id === ideaId);
      if (!i) return null;
      if (patch.title !== undefined) i.title = patch.title;
      if (patch.description !== undefined) i.description = patch.description;
      return i;
    },
    async archiveIdea(ideaId) {
      const i = ideaStore.find(i => i.id === ideaId);
      if (i) i.archived = true;
    },
    async createIdeaActivity(ideaId, body) {
      return {
        id: "activity-1",
        ideaId,
        kind: body.kind,
        content: body.content ?? null,
        actorId: body.actorId,
        metadata: body.metadata ?? null,
        createdAt: "2026-05-27T01:00:00Z",
      };
    },
    async listShortcuts(teamId, { parentId } = {}) {
      let items = shortcutStore.filter(s => s.teamId === teamId);
      if (parentId !== undefined) {
        items = items.filter(s => s.parentId === parentId);
      }
      return items;
    },
    async createShortcut(body) {
      const s = {
        id: body.id ?? "shortcut-new",
        teamId: body.teamId,
        parentId: body.parentId ?? null,
        kind: body.kind,
        label: body.label,
        payload: body.payload ?? null,
        position: body.position ?? 0,
        visibleRoleIds: body.visibleRoleIds ?? [],
        createdAt: "2026-05-27T01:00:00Z",
        updatedAt: "2026-05-27T01:00:00Z",
      };
      shortcutStore.push(s);
      return s;
    },
    async updateShortcut(shortcutId, patch) {
      const s = shortcutStore.find(s => s.id === shortcutId);
      if (!s) return null;
      if (patch.label !== undefined) s.label = patch.label;
      if (patch.payload !== undefined) s.payload = patch.payload;
      if (patch.parentId !== undefined) s.parentId = patch.parentId;
      if (patch.position !== undefined) s.position = patch.position;
      s.updatedAt = "2026-05-27T02:00:00Z";
      return s;
    },
    async deleteShortcut(shortcutId) {
      const idx = shortcutStore.findIndex(s => s.id === shortcutId);
      if (idx >= 0) shortcutStore.splice(idx, 1);
    },
    async batchMoveShortcuts({ moves }) {},
    async setShortcutVisibleRoles(shortcutId, { roleIds }) {},
    async listTeamRoles(teamId) {
      return roleStore.filter(r => r.teamId === teamId);
    },
    async listTeamPermissions(teamId) {
      return permissionStore;
    },
  };
}

function fixture(name) {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", "v1", name), "utf8"));
}
