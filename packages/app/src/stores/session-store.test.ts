import { describe, it, expect, beforeEach } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclaw_pb";
import { useSessionStore } from "./session-store";

beforeEach(() => {
  useSessionStore.setState({ messages: {}, currentSessionId: null });
});

describe("session-store", () => {
  const fakeMessage = (id: string, content = "x") =>
    createMessage(MessageSchema, {
      messageId: id, sessionId: "s1", senderActorId: "a1",
      kind: MessageKind.TEXT, content, createdAt: BigInt(1),
    });

  it("appends messages", () => {
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    expect(useSessionStore.getState().messages["s1"].length).toBe(1);
  });

  it("dedupes by messageId", () => {
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    useSessionStore.getState().appendMessage("s1", fakeMessage("m1"));
    expect(useSessionStore.getState().messages["s1"].length).toBe(1);
  });

  it("returns currentMessages for currentSessionId", () => {
    useSessionStore.setState({ currentSessionId: "s1", messages: { s1: [fakeMessage("m1")] } });
    expect(useSessionStore.getState().currentMessages().length).toBe(1);
  });
});
