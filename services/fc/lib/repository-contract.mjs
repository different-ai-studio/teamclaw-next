export function runBusinessRepositoryContract({ test, assert, createRepository }) {
  test("repository contract: sessions keep canonical fields and ordering", async () => {
    const repo = createRepository();
    const rows = await repo.listSessions({ limit: 50, cursor: null });

    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 2, "contract fixture must include at least two sessions");
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "createdAt",
      "hasUnread",
      "ideaId",
      "lastMessageAt",
      "lastMessagePreview",
      "mode",
      "teamId",
      "title",
      "updatedAt",
      "id",
    ].sort());

    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        compareSessionRows(rows[i - 1], rows[i]) <= 0,
        "sessions must be ordered by lastMessageAt desc nulls last, then createdAt desc, then id desc",
      );
    }
  });

  test("repository contract: messages keep canonical fields and ascending order", async () => {
    const repo = createRepository();
    const rows = await repo.listMessages("session-1");

    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 2, "contract fixture must include at least two messages");
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "content",
      "createdAt",
      "id",
      "kind",
      "metadata",
      "model",
      "replyToMessageId",
      "senderActorId",
      "sessionId",
      "teamId",
      "turnId",
      "updatedAt",
    ].sort());

    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        compareMessageRows(rows[i - 1], rows[i]) <= 0,
        "messages must be ordered by createdAt asc, then id asc",
      );
    }
  });

  test("repository contract: duplicate message ids surface as conflicts", async () => {
    const repo = createRepository();
    await assert.rejects(
      () => repo.insertMessage("session-1", {
        id: "duplicate-message",
        teamId: "team-1",
        senderActorId: "actor-1",
        content: "duplicate",
      }),
      (error) => error?.code === "23505" || error?.code === "conflict",
    );
  });

  test("repository contract: patchMessage updates content", async () => {
    const repo = createRepository();
    const patched = await repo.patchMessage("message-1", { content: "updated content" });
    assert.ok(patched, "patched message should exist");
    assert.equal(patched.content, "updated content");
    assert.equal(patched.id, "message-1");
  });

  test("repository contract: deleteMessage removes row", async () => {
    const repo = createRepository();
    await repo.deleteMessage("message-1");
    const messages = await repo.listMessages("session-1");
    assert.ok(messages.every(m => m.id !== "message-1"), "message should be deleted");
  });

  test("repository contract: listWorkspaces returns paged team workspaces", async () => {
    const repo = createRepository();
    const page = await repo.listWorkspaces({ teamId: "team-1", limit: 50, cursor: null });

    assert.ok(Array.isArray(page.items));
    assert.ok(page.items.length >= 1, "contract fixture must include at least one workspace");
    assert.deepEqual(Object.keys(page.items[0]).sort(), [
      "archived",
      "createdAt",
      "id",
      "metadata",
      "name",
      "slug",
      "teamId",
      "updatedAt",
    ].sort());
  });

  test("repository contract: upsertWorkspace returns inserted row", async () => {
    const repo = createRepository();
    const w = await repo.upsertWorkspace({
      id: "workspace-new",
      teamId: "team-1",
      name: "New Workspace",
    });
    assert.equal(w.id, "workspace-new");
    assert.equal(w.archived, false);
  });

  test("repository contract: getWorkspace returns single workspace", async () => {
    const repo = createRepository();
    const w = await repo.getWorkspace("workspace-1");
    assert.ok(w, "workspace should exist");
    assert.equal(w.name, "Alpha");
  });

  test("repository contract: patchWorkspace mutates name / archived", async () => {
    const repo = createRepository();
    const w = await repo.patchWorkspace("workspace-1", { archived: true });
    assert.equal(w.archived, true);
  });

  test("repository contract: getTeamWorkspaceConfig returns null when absent", async () => {
    const repo = createRepository();
    const cfg = await repo.getTeamWorkspaceConfig("team-no-config");
    assert.equal(cfg, null);
  });

  test("repository contract: putTeamWorkspaceConfig upserts row", async () => {
    const repo = createRepository();
    const teamId = "team-1";
    const next = {
      teamId,
      defaultWorkspaceId: "workspace-1",
      pinnedWorkspaceIds: [],
    };
    const out = await repo.putTeamWorkspaceConfig(teamId, next);
    assert.deepEqual(out.defaultWorkspaceId, "workspace-1");
    assert.deepEqual(out.pinnedWorkspaceIds, []);

    const cfg = await repo.getTeamWorkspaceConfig(teamId);
    assert.ok(cfg, "config should exist after put");
    assert.deepEqual(cfg.defaultWorkspaceId, "workspace-1");
  });

  test("repository contract: getSession returns session with participants", async () => {
    const repo = createRepository();
    const s = await repo.getSession("session-1");
    assert.ok(s, "session should exist");
    assert.equal(s.id, "session-1");
    assert.ok(Array.isArray(s.participants), "participants should be an array");
  });

  test("repository contract: patchSession mutates title", async () => {
    const repo = createRepository();
    const s = await repo.patchSession("session-1", { title: "Updated title" });
    assert.ok(s, "session should exist");
    assert.equal(s.title, "Updated title");
  });

  test("repository contract: createSession returns session with participants", async () => {
    const repo = createRepository();
    const s = await repo.createSession({
      id: "session-new",
      teamId: "team-1",
      title: "New Session",
      mode: "solo",
      participantActorIds: ["actor-1"],
    });
    assert.equal(s.id, "session-new");
    assert.equal(s.title, "New Session");
    assert.ok(Array.isArray(s.participants), "participants should be an array");
  });

  test("repository contract: markSessionViewed succeeds", async () => {
    const repo = createRepository();
    await repo.markSessionViewed("session-1");
  });

  test("repository contract: listSessionParticipants returns items", async () => {
    const repo = createRepository();
    const out = await repo.listSessionParticipants("session-1");
    assert.ok(Array.isArray(out.items), "items should be an array");
  });

  test("repository contract: upsertSessionParticipant returns participant", async () => {
    const repo = createRepository();
    const p = await repo.upsertSessionParticipant("session-1", { actorId: "actor-new", role: "member" });
    assert.equal(p.actorId, "actor-new");
    assert.equal(p.role, "member");
  });

  test("repository contract: removeSessionParticipant succeeds", async () => {
    const repo = createRepository();
    await repo.removeSessionParticipant("session-1", "actor-1");
  });

  test("repository contract: getSessionByAcp returns null when absent", async () => {
    const repo = createRepository();
    const out = await repo.getSessionByAcp("acp-missing");
    assert.equal(out, null);
  });

  test("repository contract: ensureGatewaySession is idempotent", async () => {
    const repo = createRepository();
    const first = await repo.ensureGatewaySession({
      teamId: "team-1",
      binding: "wecom:room#1",
      title: "Stand-up",
      primaryAgentActorId: "actor-1",
      ownerMemberActorIds: [],
      participantActorIds: [],
    });
    assert.ok(first.sessionId, "sessionId should be present");
    assert.ok(first.gatewaySessionId, "gatewaySessionId should be present");
    assert.equal(first.created, true);

    const second = await repo.ensureGatewaySession({
      teamId: "team-1",
      binding: "wecom:room#1",
      title: "Stand-up",
      primaryAgentActorId: "actor-1",
      ownerMemberActorIds: [],
      participantActorIds: [],
    });
    assert.equal(first.sessionId, second.sessionId, "sessionId should be identical");
    assert.equal(second.created, false, "second call should not create new session");
  });

  test("repository contract: createCronSession returns sessionId", async () => {
    const repo = createRepository();
    const out = await repo.createCronSession({
      teamId: "team-1",
      primaryAgentActorId: "actor-1",
      title: "Daily summary",
    });
    assert.ok(out.sessionId, "sessionId should be present");
  });

  test("repository contract: listTeamActors returns paged team actors", async () => {
    const repo = createRepository();
    const page = await repo.listTeamActors("team-1", { kind: null, limit: 200 });

    assert.ok(Array.isArray(page.items));
    assert.ok(page.items.length >= 1, "contract fixture must include at least one actor");
    assert.deepEqual(Object.keys(page.items[0]).sort(), [
      "avatarUrl",
      "displayName",
      "id",
      "kind",
      "metadata",
      "teamId",
    ].sort());
  });

  test("repository contract: getActor returns single actor", async () => {
    const repo = createRepository();
    const actor = await repo.getActor("actor-1");
    assert.ok(actor, "actor should exist");
    assert.equal(actor.displayName, "Test Actor");
  });

  test("repository contract: getActor returns null for missing actor", async () => {
    const repo = createRepository();
    const actor = await repo.getActor("actor-missing");
    assert.equal(actor, null);
  });

  test("repository contract: upsertExternalActor returns actorId", async () => {
    const repo = createRepository();
    const result = await repo.upsertExternalActor({
      teamId: "team-1",
      source: "wecom",
      sourceId: "external-1",
      displayName: "External User",
    });
    assert.ok(result.actorId, "actorId must be present");
  });

  test("repository contract: listConnectedAgents returns agent list", async () => {
    const repo = createRepository();
    const result = await repo.listConnectedAgents("team-1");
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length >= 1, "contract fixture must include at least one connected agent");
    assert.equal(result.items[0].kind, "agent");
  });

  test("repository contract: updateOwnedAgentProfile succeeds", async () => {
    const repo = createRepository();
    await repo.updateOwnedAgentProfile("agent-1", {
      displayName: "Updated Agent",
      avatarUrl: null,
      description: null,
    });
  });

  test("repository contract: updateAgentDefaults succeeds", async () => {
    const repo = createRepository();
    await repo.updateAgentDefaults("agent-1", {
      defaultAgentType: "claude",
      supportedAgentTypes: ["claude", "gpt"],
    });
  });

  test("repository contract: checkAgentPermission returns allowed when access exists", async () => {
    const repo = createRepository();
    const result = await repo.checkAgentPermission("agent-1", "actor-1");
    assert.equal(result.allowed, true);
    assert.ok(result.role, "role must be present when allowed");
  });

  test("repository contract: checkAgentPermission returns not allowed when no access", async () => {
    const repo = createRepository();
    const result = await repo.checkAgentPermission("agent-1", "actor-no-access");
    assert.equal(result.allowed, false);
    assert.equal(result.role, null);
  });

  test("repository contract: listAgentAccess returns access list", async () => {
    const repo = createRepository();
    const result = await repo.listAgentAccess("agent-1");
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length >= 1, "contract fixture must include at least one access entry");
    assert.deepEqual(Object.keys(result.items[0]).sort(), [
      "actorId",
      "agentActorId",
      "role",
    ].sort());
  });

  test("repository contract: grantAgentAccess upserts access", async () => {
    const repo = createRepository();
    const result = await repo.grantAgentAccess("agent-1", {
      actorId: "actor-new",
      role: "view",
    });
    assert.equal(result.actorId, "actor-new");
    assert.equal(result.role, "view");
  });

  test("repository contract: revokeAgentAccess removes access", async () => {
    const repo = createRepository();
    await repo.revokeAgentAccess("agent-1", "actor-to-remove");
  });

  test("repository contract: listAgentAdminMembers returns admin actor IDs", async () => {
    const repo = createRepository();
    const result = await repo.listAgentAdminMembers("agent-1");
    assert.ok(Array.isArray(result.items));
    assert.ok(result.items.length >= 1, "contract fixture must include at least one admin");
    for (const id of result.items) {
      assert.ok(typeof id === "string", "admin member IDs must be strings");
    }
  });

test("repository contract: getTeamDirectory returns actors and members", async () => {
    const repo = createRepository();
    const result = await repo.getTeamDirectory("team-1");

    assert.ok(Array.isArray(result.actors), "actors must be an array");
    assert.ok(Array.isArray(result.members), "members must be an array");
    assert.ok(result.actors.length >= 1, "contract fixture must include at least one actor");
    assert.ok(result.members.length >= 1, "contract fixture must include at least one member");

    const actor = result.actors[0];
    assert.deepEqual(Object.keys(actor).sort(), [
      "avatarUrl",
      "displayName",
      "id",
      "kind",
      "metadata",
      "teamId",
    ].sort());

    const member = result.members[0];
    assert.deepEqual(Object.keys(member).sort(), [
      "actorId",
      "joinedAt",
      "role",
      "teamId",
    ].sort());
  });

  test("repository contract: renameTeam updates team name", async () => {
    const repo = createRepository();
    const team = await repo.renameTeam("team-1", { name: "Updated Team Name" });
    assert.ok(team, "team should exist");
    assert.equal(team.id, "team-1");
    assert.equal(team.name, "Updated Team Name");
  });

  test("repository contract: createTeamInvite returns invite details", async () => {
    const repo = createRepository();
    const result = await repo.createTeamInvite("team-1", {
      actorType: "user",
      displayName: "New User",
      role: "member",
      expiresAt: null,
    });
    assert.ok(result.token, "token must be present");
    assert.ok(result.inviteId, "inviteId must be present");
    assert.equal(result.expiresAt, null);
  });

  test("repository contract: removeTeamActor succeeds", async () => {
    const repo = createRepository();
    await repo.removeTeamActor("team-1", "actor-to-remove");
  });

  test("repository contract: getNotificationPrefs returns defaults when absent", async () => {
    const repo = createRepository();
    const prefs = await repo.getNotificationPrefs();
    assert.ok(prefs.userId === null || typeof prefs.userId === "string");
    assert.equal(typeof prefs.pushEnabled, "boolean");
    assert.equal(typeof prefs.emailEnabled, "boolean");
    assert.ok(["off", "daily", "weekly"].includes(prefs.digestFrequency));
  });

  test("repository contract: putNotificationPrefs upserts prefs", async () => {
    const repo = createRepository();
    const input = {
      userId: "user-1",
      pushEnabled: false,
      emailEnabled: true,
      digestFrequency: "daily",
    };
    const out = await repo.putNotificationPrefs(input);
    assert.deepEqual(out.userId, "user-1");
    assert.equal(out.pushEnabled, false);
    assert.equal(out.emailEnabled, true);
    assert.equal(out.digestFrequency, "daily");
  });

  test("repository contract: muteSession succeeds", async () => {
    const repo = createRepository();
    await repo.muteSession("session-1", { until: null });
  });

  test("repository contract: unmuteSession succeeds", async () => {
    const repo = createRepository();
    await repo.unmuteSession("session-1");
  });

  test("repository contract: listMutedSessions returns items", async () => {
    const repo = createRepository();
    const out = await repo.listMutedSessions();
    assert.ok(Array.isArray(out.items), "items must be an array");
    for (const id of out.items) {
      assert.ok(typeof id === "string", "muted session IDs must be strings");
    }
  });

  test("repository contract: listShortcuts returns items", async () => {
    const repo = createRepository();
    const result = await repo.listShortcuts("team-1", {});
    assert.ok(Array.isArray(result), "result must be an array");
    assert.ok(result.length >= 1, "contract fixture must include at least one shortcut");
    const shortcut = result[0];
    assert.deepEqual(Object.keys(shortcut).sort(), [
      "createdAt",
      "id",
      "kind",
      "label",
      "parentId",
      "payload",
      "position",
      "teamId",
      "updatedAt",
      "visibleRoleIds",
    ].sort());
  });

  test("repository contract: createShortcut returns shortcut", async () => {
    const repo = createRepository();
    const shortcut = await repo.createShortcut({
      teamId: "team-1",
      kind: "link",
      label: "New Shortcut",
      position: 100,
    });
    assert.ok(shortcut.id, "shortcut must have id");
    assert.equal(shortcut.teamId, "team-1");
    assert.equal(shortcut.kind, "link");
    assert.equal(shortcut.label, "New Shortcut");
  });

  test("repository contract: updateShortcut mutates label", async () => {
    const repo = createRepository();
    const shortcut = await repo.updateShortcut("shortcut-1", { label: "Updated Label" });
    assert.ok(shortcut, "shortcut should exist");
    assert.equal(shortcut.label, "Updated Label");
  });

  test("repository contract: deleteShortcut succeeds", async () => {
    const repo = createRepository();
    await repo.deleteShortcut("shortcut-1");
  });

  test("repository contract: batchMoveShortcuts succeeds", async () => {
    const repo = createRepository();
    await repo.batchMoveShortcuts({
      moves: [
        { shortcutId: "shortcut-1", parentId: null, position: 0 },
      ],
    });
  });

  test("repository contract: setShortcutVisibleRoles succeeds", async () => {
    const repo = createRepository();
    await repo.setShortcutVisibleRoles("shortcut-1", { roleIds: ["role-1"] });
  });

  test("repository contract: listTeamRoles returns items", async () => {
    const repo = createRepository();
    const result = await repo.listTeamRoles("team-1");
    assert.ok(Array.isArray(result), "result must be an array");
    assert.ok(result.length >= 1, "contract fixture must include at least one role");
    const role = result[0];
    assert.deepEqual(Object.keys(role).sort(), ["code", "id", "name", "teamId"].sort());
  });

  test("repository contract: listTeamPermissions returns items", async () => {
    const repo = createRepository();
    const result = await repo.listTeamPermissions("team-1");
    assert.ok(Array.isArray(result), "result must be an array");
    assert.ok(result.length >= 1, "contract fixture must include at least one permission");
    const perm = result[0];
    assert.ok(perm.resourceId, "permission must have resourceId");
    assert.ok(Array.isArray(perm.roleIds), "roleIds must be an array");
  });

  test("repository contract: listIdeas returns paged ideas with canonical fields", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });

    assert.ok(Array.isArray(page.items));
    assert.ok(page.items.length >= 1, "contract fixture must include at least one idea");
    assert.deepEqual(Object.keys(page.items[0]).sort(), [
      "actorIds",
      "archived",
      "authorActorId",
      "createdAt",
      "description",
      "id",
      "teamId",
      "title",
      "updatedAt",
    ].sort());
  });

  test("repository contract: getIdea returns single idea", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });
    const firstId = page.items[0].id;
    const idea = await repo.getIdea(firstId);
    assert.ok(idea, "idea should exist");
    assert.equal(idea.id, firstId);
  });

  test("repository contract: getIdea returns null for missing idea", async () => {
    const repo = createRepository();
    const idea = await repo.getIdea("00000000-0000-0000-0000-000000000000");
    assert.equal(idea, null);
  });

  test("repository contract: createIdea returns idea", async () => {
    const repo = createRepository();
    const idea = await repo.createIdea({
      teamId: "team-1",
      title: "Contract Idea",
      authorActorId: "actor-1",
    });
    assert.ok(idea, "idea must be returned");
    assert.equal(idea.title, "Contract Idea");
    assert.equal(idea.archived, false);
  });

  test("repository contract: updateIdea mutates title", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });
    const firstId = page.items[0].id;
    const idea = await repo.updateIdea(firstId, { title: "Updated Title" });
    assert.ok(idea, "idea should exist");
    assert.equal(idea.title, "Updated Title");
  });

  test("repository contract: archiveIdea succeeds", async () => {
    const repo = createRepository();
    const page = await repo.listIdeas({ teamId: "team-1", archived: false, limit: 50, cursor: null });
    const firstId = page.items[0].id;
    await repo.archiveIdea(firstId);
  });

  test("repository contract: createIdeaActivity returns activity with canonical fields", async () => {
    const repo = createRepository();
    const activity = await repo.createIdeaActivity("idea-1", {
      kind: "comment",
      actorId: "actor-1",
      content: "test comment",
      metadata: null,
    });
    assert.ok(activity, "activity must be returned");
    assert.deepEqual(Object.keys(activity).sort(), [
      "actorId",
      "content",
      "createdAt",
      "id",
      "ideaId",
      "kind",
      "metadata",
    ].sort());
    assert.equal(activity.kind, "comment");
    assert.equal(activity.actorId, "actor-1");
  });
}

export function runAuthRepositoryContract({ test, assert, createAuthRepository }) {
  test("repository contract: refreshAccessToken returns new token pair", async () => {
    const repo = createAuthRepository();
    const out = await repo.refreshAccessToken({ refreshToken: "test-refresh-token" });

    assert.ok(out.accessToken, "accessToken must be present");
    assert.ok(out.refreshToken, "refreshToken must be present");
    assert.ok(Number.isInteger(out.expiresAt), "expiresAt must be an integer");
  });

  test("repository contract: upsertAgentRuntime returns id", async () => {
    const repo = createRepository();
    const result = await repo.upsertAgentRuntime({
      agentActorId: "actor-1",
      sessionId: "session-1",
      runtimeId: "runtime-abc",
      backendSessionId: "backend-session-1",
    });
    assert.ok(result.id, "id must be present");
  });

  test("repository contract: getAgentRuntime returns null when absent", async () => {
    const repo = createRepository();
    const result = await repo.getAgentRuntime({
      sessionId: "session-missing",
      runtimeId: "runtime-missing",
      backendSessionId: "backend-missing",
    });
    assert.equal(result, null);
  });

  test("repository contract: getLatestAgentRuntime returns null when absent", async () => {
    const repo = createRepository();
    const result = await repo.getLatestAgentRuntime({
      agentId: "actor-missing",
      sessionId: "session-missing",
    });
    assert.equal(result, null);
  });

  test("repository contract: updateRuntimeCursor succeeds", async () => {
    const repo = createRepository();
    await repo.updateRuntimeCursor("runtime-row-1", { lastProcessedMessageId: "message-1" });
  });

  test("repository contract: ensureAgentTypes succeeds", async () => {
    const repo = createRepository();
    await repo.ensureAgentTypes({ supportedTypes: ["openai", "claude"], defaultAgentType: "claude" });
  });

  test("repository contract: setAgentDeviceId succeeds", async () => {
    const repo = createRepository();
    await repo.setAgentDeviceId("actor-1", { deviceId: "device-abc" });
  });
}

function compareSessionRows(left, right) {
  const leftLast = left.lastMessageAt ?? "";
  const rightLast = right.lastMessageAt ?? "";
  if (leftLast !== rightLast) return rightLast.localeCompare(leftLast);

  const leftCreated = left.createdAt ?? "";
  const rightCreated = right.createdAt ?? "";
  if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);

  return right.id.localeCompare(left.id);
}

function compareMessageRows(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
  return left.id.localeCompare(right.id);
}