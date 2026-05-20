import { describe, expect, it } from "vitest";

import { emptyTimelineState, reduceTimeline } from "../features/sessions/timeline-reducer";
import type { SessionMessage } from "../features/sessions/session-types";

function msg(id: string, content: string, createdAt = "2026-05-20T10:00:00.000Z"): SessionMessage {
  return {
    content, createdAt, kind: "text", messageId: id, metadata: null,
    model: "", replyToMessageId: "", senderActorId: "agent-1",
    sessionId: "s", teamId: "t", turnId: "",
  };
}

describe("reduceTimeline · messageCommitted", () => {
  it("inserts a new message sorted by createdAt", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "first", "2026-05-20T10:00:00.000Z") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("b", "second", "2026-05-20T10:01:00.000Z") });
    expect(s.messages.map((m) => m.messageId)).toEqual(["a", "b"]);
  });

  it("replaces existing row when content is longer (streaming converges)", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hel") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello world") });
    expect(s.messages[0].content).toBe("Hello world");
  });

  it("ignores recommit with shorter or equal content", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello world") });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello") });
    expect(s.messages[0].content).toBe("Hello world");
  });

  it("clears streamingByAgent entry that committed", () => {
    let s = emptyTimelineState();
    s = reduceTimeline(s, {
      kind: "streamingDelta", agentId: "agent-1", messageId: "a",
      messageKind: "agent_reply", deltaText: "Hel", createdAt: "2026-05-20T10:00:00.000Z",
    });
    s = reduceTimeline(s, { kind: "messageCommitted", message: msg("a", "Hello") });
    expect(s.streamingByAgent.has("agent-1")).toBe(false);
  });
});
