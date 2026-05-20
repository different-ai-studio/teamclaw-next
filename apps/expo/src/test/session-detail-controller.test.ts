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
  const listeners = new Set<(message: { topic: string; payload: Uint8Array }) => void>();
  const connectionStateListeners = new Set<
    (state: "connecting" | "connected" | "disconnected") => void
  >();

  return {
    connect: vi.fn().mockImplementation(async () => {
      for (const listener of connectionStateListeners) {
        listener("connecting");
      }
      for (const listener of connectionStateListeners) {
        listener("connected");
      }
    }),
    disconnect: vi.fn().mockImplementation(async () => {
      for (const listener of connectionStateListeners) {
        listener("disconnected");
      }
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    onConnectionState: vi.fn(
      (handler: (state: "connecting" | "connected" | "disconnected") => void) => {
        connectionStateListeners.add(handler);
        return () => {
          connectionStateListeners.delete(handler);
        };
      },
    ),
    onMessage: vi.fn((handler: (message: { topic: string; payload: Uint8Array }) => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    }),
    emit(topic: string, payload: Uint8Array) {
      for (const listener of listeners) {
        listener({ topic, payload });
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
    expect(mqtt.connect).toHaveBeenCalled();
    expect(mqtt.subscribe).toHaveBeenCalledWith("amux/team-1/session/session-1/live");
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

  it("blocks sends until realtime has finished connecting", async () => {
    const { createSessionDetailController } = await import(
      "../features/sessions/session-detail-controller"
    );
    const deferredConnect = createDeferred<void>();
    const mqtt = createMockMqtt();
    mqtt.connect.mockImplementationOnce(async () => {
      mqtt.emitConnectionState("connecting");
      await deferredConnect.promise;
      mqtt.emitConnectionState("connected");
    });
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

    const loadPromise = controller.load();
    await Promise.resolve();
    await Promise.resolve();
    controller.setComposerText("too early");
    await controller.sendMessage();

    expect(controller.getState().sendErrorMessage).toMatch(/^实时连接/);
    expect(api.insertOutgoingMessage).not.toHaveBeenCalled();

    deferredConnect.resolve();
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
    const deferredConnect = createDeferred<void>();
    const mqtt = createMockMqtt();
    mqtt.connect.mockReturnValueOnce(deferredConnect.promise);
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

    const loadPromise = controller.load();
    controller.dispose();
    deferredConnect.resolve();
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
