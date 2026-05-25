import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it } from "vitest";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclaw_pb";
import { persistStreamingPartsForReply } from "@/lib/streaming-persist";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

beforeEach(() => {
  useSessionMessageStore.setState({ messages: {}, messageRefreshTrigger: 0 });
  useV2StreamingStore.setState({ byKey: {}, archived: [] });
});

describe("persistStreamingPartsForReply", () => {
  it("attaches ordered runtime parts to the final reply", async () => {
    const stream = useV2StreamingStore.getState();
    stream.appendOutput("s1", "actor-a", "Before tools.");
    for (const toolId of ["tool-a", "tool-b", "tool-c"]) {
      stream.pushToolUse("s1", "actor-a", {
        toolId,
        toolName: "grep",
        description: `search ${toolId}`,
        params: {},
        toolKind: "search",
      });
      useV2StreamingStore.getState().completeToolUse("s1", "actor-a", {
        toolId,
        success: true,
        summary: `result ${toolId}`,
      });
    }
    useV2StreamingStore.getState().appendOutput("s1", "actor-a", "After tools.");

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "actor-a",
      kind: MessageKind.AGENT_REPLY,
      content: "After tools.",
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "actor-a", reply);

    expect(useSessionMessageStore.getState().messages.s1).toBeUndefined();
    const parts = JSON.parse((reply as unknown as { partsJson: string }).partsJson);
    expect(parts.map((part: { type: string }) => part.type)).toEqual([
      "text",
      "tool-call",
      "tool-call",
      "tool-call",
      "text",
    ]);
    expect(parts[0].text).toBe("Before tools.");
    expect(parts[1].toolCall.id).toBe("tool-a");
    expect(parts[1].toolCall.status).toBe("completed");
    expect(parts[4].text).toBe("After tools.");
  });
});
