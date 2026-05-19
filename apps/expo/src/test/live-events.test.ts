import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";

import {
  LiveEventEnvelopeSchema,
  MessageKind,
  MessageSchema,
  SessionMessageEnvelopeSchema,
} from "@teamclaw/app/proto/teamclaw_pb";
import { decodeLiveEvent, sessionIdFromTopic } from "../lib/teamclaw/live-events";

describe("decodeLiveEvent", () => {
  it("decodes valid message.created payloads", () => {
    const message = create(MessageSchema, {
      messageId: "message-1",
      sessionId: "session-1",
      senderActorId: "actor-1",
      kind: MessageKind.TEXT,
      content: "hello world",
      createdAt: BigInt(1000),
    });

    const sessionMessage = create(SessionMessageEnvelopeSchema, {
      message,
    });

    const liveEvent = create(LiveEventEnvelopeSchema, {
      eventId: "event-1",
      eventType: "message.created",
      sessionId: "session-1",
      actorId: "actor-1",
      sentAt: BigInt(1000),
      body: toBinary(SessionMessageEnvelopeSchema, sessionMessage),
    });

    const decoded = decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, liveEvent));

    expect(decoded).not.toBeNull();
    expect(decoded?.envelope.eventType).toBe("message.created");
    expect(decoded?.sessionMessage?.message?.messageId).toBe("message-1");
    expect(decoded?.message?.content).toBe("hello world");
  });

  it("returns null for invalid live envelopes", () => {
    expect(decodeLiveEvent(new Uint8Array([255, 255, 255]))).toBeNull();
  });

  it("returns null when a message.created body is malformed", () => {
    const liveEvent = create(LiveEventEnvelopeSchema, {
      eventId: "event-1",
      eventType: "message.created",
      sessionId: "session-1",
      actorId: "actor-1",
      sentAt: BigInt(1000),
      body: new Uint8Array([255, 255, 255]),
    });

    expect(decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, liveEvent))).toBeNull();
  });

  it("returns null when a message.created body decodes without an inner message", () => {
    const liveEvent = create(LiveEventEnvelopeSchema, {
      eventId: "event-2",
      eventType: "message.created",
      sessionId: "session-1",
      actorId: "actor-1",
      sentAt: BigInt(1000),
      body: toBinary(SessionMessageEnvelopeSchema, create(SessionMessageEnvelopeSchema, {})),
    });

    expect(decodeLiveEvent(toBinary(LiveEventEnvelopeSchema, liveEvent))).toBeNull();
  });
});

describe("sessionIdFromTopic", () => {
  it("parses session id from live event topics", () => {
    expect(sessionIdFromTopic("amux/team-1/session/session-1/live")).toBe("session-1");
  });

  it("returns null for non-live topics", () => {
    expect(sessionIdFromTopic("amux/team-1/session/session-1/state")).toBeNull();
  });
});
