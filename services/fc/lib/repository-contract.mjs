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