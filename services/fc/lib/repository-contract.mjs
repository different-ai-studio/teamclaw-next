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
}

export function runAuthRepositoryContract({ test, assert, createAuthRepository }) {
  test("repository contract: refreshAccessToken returns new token pair", async () => {
    const repo = createAuthRepository();
    const out = await repo.refreshAccessToken({ refreshToken: "test-refresh-token" });

    assert.ok(out.accessToken, "accessToken must be present");
    assert.ok(out.refreshToken, "refreshToken must be present");
    assert.ok(Number.isInteger(out.expiresAt), "expiresAt must be an integer");
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