export function runBusinessRepositoryContract({ test, assert, createRepository }) {
  test("repository contract: sessions keep canonical fields and ordering", async () => {
    const repo = createRepository();
    const rows = await repo.listSessions({ limit: 50, cursor: null });

    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 2, "contract fixture must include at least two sessions");
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "createdAt",
      "hasUnread",
      "id",
      "ideaId",
      "lastMessageAt",
      "lastMessagePreview",
      "mode",
      "teamId",
      "title",
      "updatedAt",
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
