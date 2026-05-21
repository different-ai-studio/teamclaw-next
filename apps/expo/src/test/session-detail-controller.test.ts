import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@teamclaw/app/proto/teamclaw_pb";
import type { SessionMessage, SessionSummary } from "../features/sessions/session-types";

function createSession(): SessionSummary {
  return {
    sessionId: "session-1",
    teamId: "team-1",
    title: "Session title",
    summary: "",
    participantCount: 2,
    participantActorIds: ["actor-1", "actor-agent"],
    lastMessagePreview: "Latest preview",
    lastMessageAt: "2026-05-19T08:20:00.000Z",
    createdAt: "2026-05-19T08:00:00.000Z",
    createdBy: "actor-1",
  };
}

function createRowMessage(messageId: string, senderActorId = "actor-1"): SessionMessage {
  return {
    content: `Message ${messageId}`,
    createdAt: "2026-05-19T08:20:00.000Z",
    kind: "text",
    messageId,
    metadata: null,
    model: "",
    replyToMessageId: "",
    senderActorId,
    sessionId: "session-1",
    teamId: "team-1",
    turnId: "",
  };
}

function createLivePayload(input: {
  content: string;
  createdAtSeconds?: bigint;
  messageId: string;
  senderActorId: string;
}) {
  const message = create(MessageSchema, {
    messageId: input.messageId,
    sessionId: "session-1",
    senderActorId: input.senderActorId,
    kind: MessageKind.TEXT,
    content: input.content,
    createdAt: input.createdAtSeconds ?? BigInt(1_747_642_000),
  });
  const sessionMessage = create(SessionMessageEnvelopeSchema, {
    message,
    mentionActorIds: [],
  });
  const envelope = create(LiveEventEnvelopeSchema, {
    eventId: `event-${input.messageId}`,
    eventType: "message.created",
    sessionId: "session-1",
    actorId: input.senderActorId,
    sentAt: input.createdAtSeconds ?? BigInt(1_747_642_000),
    body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
  });

  return toBinary(LiveEventEnvelopeSchema, envelope);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createMockMqtt() {
  // Maps filter → handler. Uses the first registered handler per filter
  // for simplicity (the controller only subscribes once per topic).
  const topicHandlers = new Map<string, (payload: Uint8Array, topic: string) => void>();
  const connectionStateListeners = new Set<
    (state: "connecting" | "connected" | "disconnected") => void
  >();

  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((filter: string, handler: (payload: Uint8Array, topic: string) => void) => {
      topicHandlers.set(filter, handler);
      return () => {
        topicHandlers.delete(filter);
      };
    }),
    onConnectionState: vi.fn(
      (handler: (state: "connecting" | "connected" | "disconnected") => void) => {
        connectionStateListeners.add(handler);
        return () => {
          connectionStateListeners.delete(handler);
        };
      },
    ),
    /** Simulate an inbound MQTT message on a given topic. */
    emit(topic: string, payload: Uint8Array) {
      for (const [filter, handler] of topicHandlers) {
        // Simple exact-match check is sufficient for these tests.
        if (filter === topic) {
          handler(payload, topic);
        }
      }
    },
    emitConnectionState(state: "connecting" | "connected" | "disconnected") {
      for (const listener of connectionStateListeners) {
        listener(state);
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionDetailController", () => {
  it("loads into ready state and connects realtime for the active session", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([createRowMessage("message-1")]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();

    expect(controller.getState()).toMatchObject({
      connectionState: "connected",
      messages: [expect.objectContaining({ messageId: "message-1" })],
      status: "ready",
    });
    expect(mqtt.subscribe).toHaveBeenCalledWith(
      "amux/team-1/session/session-1/live",
      expect.any(Function),
    );
  });

  it("optimistically appends a sent message and clears the composer text", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    controller.setComposerText("hello");
    await controller.sendMessage();

    expect(controller.getState().composerText).toBe("");
    expect(controller.getState().messages).toHaveLength(1);
    expect(controller.getState().messages[0]?.content).toBe("hello");
    expect(mqtt.publish).toHaveBeenCalledTimes(1);
  });

  it("sends a pending attachment even when composer text is empty", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const { appendPendingAttachment, takePendingAttachments } = await import(
      "../features/sessions/pending-attachments"
    );
    takePendingAttachments("team-1", "session-1");
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    appendPendingAttachment("team-1", "session-1", {
      path: "team-1/session-1/photo.png",
      publicUrl: "https://storage.example.test/photo.png?token=abc",
      mime: "image/png",
      size: 123,
    });
    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    await controller.sendMessage();

    expect(api.insertOutgoingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "",
        attachments: [
          {
            url: "https://storage.example.test/photo.png?token=abc",
            path: "team-1/session-1/photo.png",
            mime: "image/png",
            size: 123,
          },
        ],
      }),
    );
    expect(controller.getState().messages[0]).toMatchObject({
      content: "",
      attachments: [
        {
          url: "https://storage.example.test/photo.png?token=abc",
          path: "team-1/session-1/photo.png",
        },
      ],
    });
    expect(takePendingAttachments("team-1", "session-1")).toHaveLength(0);
  });

  it("blocks sends until realtime has finished connecting", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    // Defer the second listMessages call (the one inside connectRealtime)
    // so the controller stays in "connecting" long enough to test the guard.
    const deferredListMessages = createDeferred<ReturnType<typeof createRowMessage>[]>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockResolvedValue(undefined),
      listMessages: vi.fn()
        .mockResolvedValueOnce([]) // first call (load phase)
        .mockReturnValueOnce(deferredListMessages.promise), // second call (connectRealtime)
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    const loadPromise = controller.load();
    // Flush enough microtasks so that connectRealtime has started but not finished.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.setComposerText("too early");
    await controller.sendMessage();

    // connectionState should not yet be "connected" so send is blocked.
    expect(controller.getState().sendErrorMessage).toMatch(/^实时连接/);
    expect(api.insertOutgoingMessage).not.toHaveBeenCalled();

    deferredListMessages.resolve([]);
    await loadPromise;
  });

  it("ignores duplicate mqtt messages by messageId", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([createRowMessage("message-1")]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createLivePayload({
        content: "duplicate",
        messageId: "message-1",
        senderActorId: "actor-agent",
      }),
    );

    expect(controller.getState().messages).toHaveLength(1);
  });

  it("merges a subsequent agent reply from mqtt", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emit(
      "amux/team-1/session/session-1/live",
      createLivePayload({
        content: "agent reply",
        messageId: "agent-reply-1",
        senderActorId: "actor-agent",
      }),
    );

    expect(controller.getState().messages).toEqual([
      expect.objectContaining({
        content: "agent reply",
        messageId: "agent-reply-1",
        senderActorId: "actor-agent",
      }),
    ]);
  });

  it("replays persisted messages fetched after subscribe to close the load gap", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([createRowMessage("message-gap", "actor-agent")]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();

    expect(api.listMessages).toHaveBeenCalledTimes(2);
    expect(controller.getState().messages).toEqual([
      expect.objectContaining({ messageId: "message-gap" }),
    ]);
  });

  it("preserves composer text when send insert fails", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn().mockRejectedValue(new Error("insert failed")),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    controller.setComposerText("still here");
    await controller.sendMessage();

    expect(controller.getState()).toMatchObject({
      composerText: "still here",
      sendErrorMessage: "insert failed",
    });
  });

  it("does not let stale connect completions mutate a disposed controller", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    // Defer the second listMessages call inside connectRealtime so we can
    // dispose the controller while it is still mid-flight.
    const deferredListMessages = createDeferred<ReturnType<typeof createRowMessage>[]>();
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn()
        .mockResolvedValueOnce([]) // first call (load phase)
        .mockReturnValueOnce(deferredListMessages.promise), // second call (connectRealtime)
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    const loadPromise = controller.load();
    controller.dispose();
    deferredListMessages.resolve([]);
    await loadPromise;

    expect(controller.getState().connectionState).toBe("disconnected");
  });

  it("downgrades the connection state when realtime drops after load", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const mqtt = createMockMqtt();
    const api = {
      getSession: vi.fn().mockResolvedValue(createSession()),
      insertOutgoingMessage: vi.fn(),
      listMessages: vi.fn().mockResolvedValue([]),
      resolveMemberActorId: vi.fn().mockResolvedValue("actor-1"),
      markSessionRead: vi.fn().mockResolvedValue(undefined),
    };

    const controller = createSessionDetailController({
      api: api as any,
      currentMemberActorId: "actor-1",
      getAuth: vi.fn().mockResolvedValue({
        accessToken: "jwt-token",
        userId: "user-1",
      }),
      mqtt: mqtt as any,
      mqttUrl: "wss://broker.example.com/mqtt",
      sessionId: "session-1",
      teamId: "team-1",
    });

    await controller.load();
    mqtt.emitConnectionState("disconnected");

    expect(controller.getState().connectionState).toBe("disconnected");
  });
});
