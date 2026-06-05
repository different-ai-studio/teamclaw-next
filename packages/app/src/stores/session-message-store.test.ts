import { beforeEach, describe, expect, it } from "vitest";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclaw_pb";
import { useSessionSelectionStore } from "./session-selection-store";
import { useSessionMessageStore } from "./session-message-store";

beforeEach(() => {
  useSessionSelectionStore.setState({
    activeSessionId: null,
    currentSessionId: null,
    viewingArchivedSessionId: null,
    viewingChildSessionId: null,
  });
  useSessionMessageStore.setState({
    messages: {},
    messageRefreshTrigger: 0,
    messageRefreshForceFull: false,
  });
});

describe("session-message-store", () => {
  const fakeMessage = (id: string, content = "x") =>
    createMessage(MessageSchema, {
      messageId: id,
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.TEXT,
      content,
      createdAt: BigInt(1),
    });

  it("appends messages by session", () => {
    useSessionMessageStore.getState().appendMessage("s1", fakeMessage("m1"));

    expect(useSessionMessageStore.getState().messages.s1).toHaveLength(1);
  });

  it("dedupes appended messages by messageId", () => {
    useSessionMessageStore.getState().appendMessage("s1", fakeMessage("m1"));
    useSessionMessageStore.getState().appendMessage("s1", fakeMessage("m1"));

    expect(useSessionMessageStore.getState().messages.s1).toHaveLength(1);
  });

  it("returns current messages from the v2 selection store", () => {
    useSessionSelectionStore.setState({
      activeSessionId: "s1",
      currentSessionId: "s1",
    });
    useSessionMessageStore.getState().setMessages("s1", [fakeMessage("m1")]);

    expect(useSessionMessageStore.getState().currentMessages()).toHaveLength(1);
  });

  it("bumps refresh trigger for active session reloads", async () => {
    await useSessionMessageStore.getState().reloadActiveSessionMessages();

    expect(useSessionMessageStore.getState().messageRefreshTrigger).toBe(1);
  });

  it("sets force-full flag when requested", async () => {
    await useSessionMessageStore.getState().reloadActiveSessionMessages({ full: true });

    expect(useSessionMessageStore.getState().messageRefreshForceFull).toBe(true);
  });

  it("replaceTurnAgentRepliesInStore keeps one agent_reply per turn", () => {
    const first = createMessage(MessageSchema, {
      messageId: "r1",
      sessionId: "s1",
      senderActorId: "agent",
      kind: MessageKind.AGENT_REPLY,
      content: "first",
      turnId: "turn-1",
      createdAt: BigInt(1),
    });
    const second = createMessage(MessageSchema, {
      messageId: "r2",
      sessionId: "s1",
      senderActorId: "agent",
      kind: MessageKind.AGENT_REPLY,
      content: "second",
      turnId: "turn-1",
      createdAt: BigInt(2),
    });
    useSessionMessageStore.getState().appendMessage("s1", first);
    useSessionMessageStore.getState().replaceTurnAgentRepliesInStore("s1", second);

    const rows = useSessionMessageStore.getState().messages.s1 ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBe("r2");
    expect(rows[0]?.content).toBe("second");
  });
});
