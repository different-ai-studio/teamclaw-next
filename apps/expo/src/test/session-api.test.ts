import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});

function createQueryMock<T>(result: Promise<T>) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockReturnValue(result),
    single: vi.fn().mockReturnValue(result),
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

describe("session domain helpers", () => {
  it("mapSessionRecord normalizes nullable backend fields", async () => {
    const { mapSessionRecord } = await import("../features/sessions/session-types");

    expect(
      mapSessionRecord({
        session_id: "session-1",
        team_id: null,
        title: null,
        summary: "  ",
        participant_count: null,
        last_message_preview: null,
        last_message_at: null,
        created_at: "2026-05-18T09:30:00+08:00",
        created_by: null,
      }),
    ).toEqual({
      sessionId: "session-1",
      teamId: "",
      title: "",
      summary: "  ",
      participantCount: 0,
      participantActorIds: [],
      lastMessagePreview: "",
      lastMessageAt: "",
      createdAt: "2026-05-18T09:30:00+08:00",
      createdBy: "",
    });
  });

  it("mapMessageRecord normalizes nullable backend fields", async () => {
    const { mapMessageRecord } = await import("../features/sessions/session-types");

    expect(
      mapMessageRecord({
        content: null,
        created_at: "2026-05-18T08:15:00.000Z",
        kind: null,
        metadata: null,
        model: null,
        sender_actor_id: null,
        session_id: "session-1",
        team_id: "team-1",
        turn_id: null,
        reply_to_message_id: null,
        id: "message-1",
      }),
    ).toEqual({
      content: "",
      createdAt: "2026-05-18T08:15:00.000Z",
      kind: "",
      metadata: null,
      messageId: "message-1",
      model: "",
      replyToMessageId: "",
      senderActorId: "",
      sessionId: "session-1",
      teamId: "team-1",
      turnId: "",
    });
  });

  it("mapMessageRecord defaults nullable identifiers and timestamp to empty strings", async () => {
    const { mapMessageRecord } = await import("../features/sessions/session-types");

    expect(
      mapMessageRecord({
        content: "hello",
        created_at: null,
        kind: "text",
        metadata: null,
        model: "gpt-5",
        sender_actor_id: "actor-1",
        session_id: null,
        team_id: null,
        turn_id: null,
        reply_to_message_id: null,
        id: null,
      }),
    ).toEqual({
      content: "hello",
      createdAt: "",
      kind: "text",
      metadata: null,
      messageId: "",
      model: "gpt-5",
      replyToMessageId: "",
      senderActorId: "actor-1",
      sessionId: "",
      teamId: "",
      turnId: "",
    });
  });

  it("mapMessageRecord preserves persisted turn and reply linkage fields", async () => {
    const { mapMessageRecord } = await import("../features/sessions/session-types");

    expect(
      mapMessageRecord({
        content: "reply",
        created_at: "2026-05-18T08:20:00.000Z",
        kind: "agent_reply",
        metadata: { source: "agent" },
        model: "gpt-5",
        sender_actor_id: "actor-2",
        session_id: "session-2",
        team_id: "team-2",
        turn_id: "turn-1",
        reply_to_message_id: "message-1",
        id: "message-2",
      }),
    ).toEqual({
      content: "reply",
      createdAt: "2026-05-18T08:20:00.000Z",
      kind: "agent_reply",
      metadata: { source: "agent" },
      messageId: "message-2",
      model: "gpt-5",
      replyToMessageId: "message-1",
      senderActorId: "actor-2",
      sessionId: "session-2",
      teamId: "team-2",
      turnId: "turn-1",
    });
  });

  it("groupSessionsByRecency sorts by effective timestamp and groups today first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

    const { groupSessionsByRecency } = await import("../features/sessions/session-types");

    const groups = groupSessionsByRecency([
      {
        sessionId: "session-4",
        teamId: "team-1",
        title: "Yesterday",
        summary: "",
        participantCount: 1,
        participantActorIds: ["user-1"],
        lastMessagePreview: "",
        lastMessageAt: new Date(2026, 4, 17, 22, 0, 0).toISOString(),
        createdAt: new Date(2026, 4, 16, 10, 0, 0).toISOString(),
        createdBy: "user-1",
      },
      {
        sessionId: "session-2",
        teamId: "team-1",
        title: "Created today",
        summary: "",
        participantCount: 1,
        participantActorIds: ["user-1"],
        lastMessagePreview: "",
        lastMessageAt: "",
        createdAt: new Date(2026, 4, 18, 10, 30, 0).toISOString(),
        createdBy: "user-1",
      },
      {
        sessionId: "session-3",
        teamId: "team-1",
        title: "Earlier today",
        summary: "",
        participantCount: 1,
        participantActorIds: ["user-1"],
        lastMessagePreview: "",
        lastMessageAt: new Date(2026, 4, 18, 9, 30, 0).toISOString(),
        createdAt: new Date(2026, 4, 17, 9, 30, 0).toISOString(),
        createdBy: "user-1",
      },
      {
        sessionId: "session-1",
        teamId: "team-1",
        title: "Newest",
        summary: "",
        participantCount: 1,
        participantActorIds: ["user-1"],
        lastMessagePreview: "",
        lastMessageAt: new Date(2026, 4, 18, 11, 0, 0).toISOString(),
        createdAt: new Date(2026, 4, 17, 11, 0, 0).toISOString(),
        createdBy: "user-1",
      },
    ]);

    expect(groups).toEqual([
      {
        label: "今天",
        sessions: [
          expect.objectContaining({ sessionId: "session-1" }),
          expect.objectContaining({ sessionId: "session-2" }),
          expect.objectContaining({ sessionId: "session-3" }),
        ],
      },
      {
        label: "昨天",
        sessions: [expect.objectContaining({ sessionId: "session-4" })],
      },
    ]);
  });

  it("falls back to createdAt when lastMessageAt is present but invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 12, 0, 0));

    const { groupSessionsByRecency } = await import("../features/sessions/session-types");

    const groups = groupSessionsByRecency([
      {
        sessionId: "session-invalid-last-message",
        teamId: "team-1",
        title: "Invalid timestamp",
        summary: "",
        participantCount: 1,
        participantActorIds: ["user-1"],
        lastMessagePreview: "",
        lastMessageAt: "not-a-date",
        createdAt: new Date(2026, 4, 18, 10, 45, 0).toISOString(),
        createdBy: "user-1",
      },
    ]);

    expect(groups).toEqual([
      {
        label: "今天",
        sessions: [expect.objectContaining({ sessionId: "session-invalid-last-message" })],
      },
    ]);
  });

  it("uses the device local day boundary for 今天 versus 昨天", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 0, 30, 0));

    const { groupSessionsByRecency } = await import("../features/sessions/session-types");

    const groups = groupSessionsByRecency([
      {
        sessionId: "just-after-midnight",
        teamId: "team-1",
        title: "Just after midnight",
        summary: "",
        participantCount: 1,
        participantActorIds: ["user-1"],
        lastMessagePreview: "",
        lastMessageAt: new Date(2026, 4, 18, 0, 15, 0).toISOString(),
        createdAt: new Date(2026, 4, 18, 0, 15, 0).toISOString(),
        createdBy: "user-1",
      },
      {
        sessionId: "just-before-midnight",
        teamId: "team-1",
        title: "Just before midnight",
        summary: "",
        participantCount: 1,
        participantActorIds: ["user-1"],
        lastMessagePreview: "",
        lastMessageAt: new Date(2026, 4, 17, 23, 45, 0).toISOString(),
        createdAt: new Date(2026, 4, 17, 23, 45, 0).toISOString(),
        createdBy: "user-1",
      },
    ]);

    expect(groups).toEqual([
      {
        label: "今天",
        sessions: [expect.objectContaining({ sessionId: "just-after-midnight" })],
      },
      {
        label: "昨天",
        sessions: [expect.objectContaining({ sessionId: "just-before-midnight" })],
      },
    ]);
  });
});

describe("createSessionsApi", () => {
  it("listMessages returns session messages ordered from oldest to newest", async () => {
    const { createSessionsApi } = await import("../features/sessions/session-api");

    const messageRows = [
      {
        content: "First message",
        created_at: "2026-05-18T08:00:00.000Z",
        kind: "text",
        metadata: { mentions: ["actor-2"] },
        model: "gpt-5",
        reply_to_message_id: null,
        sender_actor_id: "actor-1",
        session_id: "session-1",
        team_id: "team-1",
        turn_id: "turn-1",
        id: "message-1",
      },
      {
        content: "Second message",
        created_at: "2026-05-18T08:01:00.000Z",
        kind: "agent_reply",
        metadata: { finish_reason: "stop" },
        model: "gpt-5",
        reply_to_message_id: "message-1",
        sender_actor_id: "actor-2",
        session_id: "session-1",
        team_id: "team-1",
        turn_id: "turn-2",
        id: "message-2",
      },
    ];

    const messageQuery = createQueryMock(Promise.resolve({ data: messageRows, error: null }));
    const from = vi.fn((table: string) => {
      if (table === "messages") return messageQuery;
      throw new Error(`unexpected table: ${table}`);
    });

    const api = createSessionsApi({ from } as any);

    await expect(api.listMessages("team-1", "session-1")).resolves.toEqual([
      {
        content: "First message",
        createdAt: "2026-05-18T08:00:00.000Z",
        kind: "text",
        metadata: { mentions: ["actor-2"] },
        messageId: "message-1",
        model: "gpt-5",
        replyToMessageId: "",
        senderActorId: "actor-1",
        sessionId: "session-1",
        teamId: "team-1",
        turnId: "turn-1",
      },
      {
        content: "Second message",
        createdAt: "2026-05-18T08:01:00.000Z",
        kind: "agent_reply",
        metadata: { finish_reason: "stop" },
        messageId: "message-2",
        model: "gpt-5",
        replyToMessageId: "message-1",
        senderActorId: "actor-2",
        sessionId: "session-1",
        teamId: "team-1",
        turnId: "turn-2",
      },
    ]);
    expect(messageQuery.select).toHaveBeenCalledWith(
      "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at",
    );
    expect(messageQuery.eq).toHaveBeenNthCalledWith(1, "team_id", "team-1");
    expect(messageQuery.eq).toHaveBeenNthCalledWith(2, "session_id", "session-1");
    expect(messageQuery.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: true });
    expect(messageQuery.order).toHaveBeenNthCalledWith(2, "id", { ascending: true });
  });

  it("listMessages applies a deterministic id tiebreaker when created_at matches", async () => {
    const { createSessionsApi } = await import("../features/sessions/session-api");

    const messageQuery = createQueryMock(Promise.resolve({
      data: [
        {
          content: "later by id",
          created_at: "2026-05-18T08:00:00.000Z",
          kind: "idea_event",
          metadata: { rank: 2 },
          model: "gpt-5",
          reply_to_message_id: null,
          sender_actor_id: "actor-2",
          session_id: "session-1",
          team_id: "team-1",
          turn_id: "turn-2",
          id: "message-2",
        },
        {
          content: "earlier by id",
          created_at: "2026-05-18T08:00:00.000Z",
          kind: "system",
          metadata: { rank: 1 },
          model: "gpt-5",
          reply_to_message_id: null,
          sender_actor_id: "actor-1",
          session_id: "session-1",
          team_id: "team-1",
          turn_id: "turn-1",
          id: "message-1",
        },
      ],
      error: null,
    }));
    const from = vi.fn((table: string) => {
      if (table === "messages") return messageQuery;
      throw new Error(`unexpected table: ${table}`);
    });

    const api = createSessionsApi({ from } as any);

    await expect(api.listMessages("team-1", "session-1")).resolves.toMatchObject([
      { messageId: "message-1", kind: "system", metadata: { rank: 1 } },
      { messageId: "message-2", kind: "idea_event", metadata: { rank: 2 } },
    ]);
  });

  it("listSessions maps sessions and participant counts for a team", async () => {
    const { createSessionsApi } = await import("../features/sessions/session-api");

    const sessionRows = [
      {
        session_id: "session-1",
        team_id: "team-1",
        title: "First session",
        summary: "Summary one",
        participant_count: null,
        last_message_preview: "First preview",
        last_message_at: "2026-05-18T08:00:00.000Z",
        created_at: "2026-05-18T07:30:00.000Z",
        created_by: "actor-1",
      },
      {
        session_id: "session-2",
        team_id: "team-1",
        title: "Second session",
        summary: "Summary two",
        participant_count: null,
        last_message_preview: "",
        last_message_at: null,
        created_at: "2026-05-17T07:30:00.000Z",
        created_by: "actor-2",
      },
    ];

    const sessionQuery = createQueryMock(Promise.resolve({ data: sessionRows, error: null }));
    const participantQuery = createQueryMock(Promise.resolve({
      data: [
        { session_id: "session-1", actor_id: "actor-1" },
        { session_id: "session-1", actor_id: "actor-3" },
        { session_id: "session-2", actor_id: "actor-2" },
      ],
      error: null,
    }));

    const from = vi.fn((table: string) => {
      if (table === "sessions") return sessionQuery;
      if (table === "session_participants") return participantQuery;
      throw new Error(`unexpected table: ${table}`);
    });

    const api = createSessionsApi({ from } as any);

    await expect(api.listSessions("team-1")).resolves.toEqual([
      {
        sessionId: "session-1",
        teamId: "team-1",
        title: "First session",
        summary: "Summary one",
        participantCount: 2,
        participantActorIds: ["actor-1", "actor-3"],
        lastMessagePreview: "First preview",
        lastMessageAt: "2026-05-18T08:00:00.000Z",
        createdAt: "2026-05-18T07:30:00.000Z",
        createdBy: "actor-1",
      },
      {
        sessionId: "session-2",
        teamId: "team-1",
        title: "Second session",
        summary: "Summary two",
        participantCount: 1,
        participantActorIds: ["actor-2"],
        lastMessagePreview: "",
        lastMessageAt: "",
        createdAt: "2026-05-17T07:30:00.000Z",
        createdBy: "actor-2",
      },
    ]);
    expect(sessionQuery.select).toHaveBeenCalledWith("session_id:id, team_id, title, summary, last_message_preview, last_message_at, created_at, created_by:created_by_actor_id");
    expect(sessionQuery.eq).toHaveBeenCalledWith("team_id", "team-1");
    expect(sessionQuery.order).toHaveBeenNthCalledWith(1, "last_message_at", { ascending: false });
    expect(sessionQuery.order).toHaveBeenNthCalledWith(2, "created_at", { ascending: false });
    expect(participantQuery.select).toHaveBeenCalledWith("session_id, actor_id");
    expect(participantQuery.order).toHaveBeenCalledWith("actor_id", { ascending: true });
    expect(participantQuery.in).toHaveBeenCalledWith("session_id", ["session-1", "session-2"]);
  });

  it("getSession returns a mapped session for the requested id", async () => {
    const { createSessionsApi } = await import("../features/sessions/session-api");

    const sessionQuery = createQueryMock(Promise.resolve({
      data: {
        session_id: "session-1",
        team_id: "team-1",
        title: "Session one",
        summary: "Summary",
        participant_count: 3,
        last_message_preview: "Latest",
        last_message_at: "2026-05-18T08:15:00.000Z",
        created_at: "2026-05-18T07:45:00.000Z",
        created_by: "actor-1",
      },
      error: null,
    }));
    const participantQuery = createQueryMock(Promise.resolve({
      data: [
        { session_id: "session-1", actor_id: "actor-1" },
        { session_id: "session-1", actor_id: "actor-2" },
        { session_id: "session-1", actor_id: "actor-3" },
      ],
      error: null,
    }));

    const from = vi.fn((table: string) => {
      if (table === "sessions") return sessionQuery;
      if (table === "session_participants") return participantQuery;
      throw new Error(`unexpected table: ${table}`);
    });

    const api = createSessionsApi({ from } as any);

    await expect(api.getSession("team-1", "session-1")).resolves.toEqual({
      sessionId: "session-1",
      teamId: "team-1",
      title: "Session one",
      summary: "Summary",
      participantCount: 3,
      participantActorIds: ["actor-1", "actor-2", "actor-3"],
      lastMessagePreview: "Latest",
      lastMessageAt: "2026-05-18T08:15:00.000Z",
      createdAt: "2026-05-18T07:45:00.000Z",
      createdBy: "actor-1",
    });
    expect(sessionQuery.select).toHaveBeenCalledWith("session_id:id, team_id, title, summary, last_message_preview, last_message_at, created_at, created_by:created_by_actor_id");
    expect(sessionQuery.eq).toHaveBeenNthCalledWith(1, "team_id", "team-1");
    expect(sessionQuery.eq).toHaveBeenNthCalledWith(2, "id", "session-1");
    expect(sessionQuery.maybeSingle).toHaveBeenCalled();
    expect(participantQuery.select).toHaveBeenCalledWith("session_id, actor_id");
    expect(participantQuery.order).toHaveBeenCalledWith("actor_id", { ascending: true });
    expect(participantQuery.in).toHaveBeenCalledWith("session_id", ["session-1"]);
  });

  it("resolveMemberActorId returns the current member actor for a team", async () => {
    const { createSessionsApi } = await import("../features/sessions/session-api");

    const actorQuery = createQueryMock(Promise.resolve({
      data: { id: "actor-1" },
      error: null,
    }));

    const from = vi.fn((table: string) => {
      if (table === "actors") return actorQuery;
      throw new Error(`unexpected table: ${table}`);
    });

    const api = createSessionsApi({ from } as any);

    await expect(api.resolveMemberActorId("team-1", "user-1")).resolves.toBe("actor-1");
    expect(actorQuery.select).toHaveBeenCalledWith("id");
    expect(actorQuery.eq).toHaveBeenNthCalledWith(1, "team_id", "team-1");
    expect(actorQuery.eq).toHaveBeenNthCalledWith(2, "user_id", "user-1");
    expect(actorQuery.eq).toHaveBeenNthCalledWith(3, "actor_type", "member");
    expect(actorQuery.limit).toHaveBeenCalledWith(1);
    expect(actorQuery.maybeSingle).toHaveBeenCalled();
  });

  it("insertOutgoingMessage persists a text message row for the current session", async () => {
    const { createSessionsApi } = await import("../features/sessions/session-api");

    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => {
      if (table === "messages") return { insert };
      throw new Error(`unexpected table: ${table}`);
    });

    const api = createSessionsApi({ from } as any);

    await api.insertOutgoingMessage({
      id: "message-1",
      teamId: "team-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      content: "Hello from Expo",
      createdAt: "2026-05-18T08:00:00.000Z",
    });

    expect(insert).toHaveBeenCalledWith({
      id: "message-1",
      team_id: "team-1",
      session_id: "session-1",
      sender_actor_id: "actor-1",
      kind: "text",
      content: "Hello from Expo",
      metadata: null,
      model: null,
      turn_id: null,
      reply_to_message_id: null,
      created_at: "2026-05-18T08:00:00.000Z",
    });
  });
});
