import { describe, it, expect, beforeEach } from "vitest";
import { useV2StreamingStore, selectStreamsForSession } from "../v2-streaming-store";

beforeEach(() => {
  // Reset to a clean state
  useV2StreamingStore.setState({ byKey: {}, archived: [] });
});

describe("v2-streaming-store", () => {
  it("appendOutput accumulates deltas for the same actor", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "Hello ");
    useV2StreamingStore.getState().appendOutput("s1", "a1", "world");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams).toHaveLength(1);
    expect(streams[0].outputText).toBe("Hello world");
    expect(streams[0].parts.map((p) => p.type)).toEqual(["text"]);
    expect(streams[0].parts[0].text).toBe("Hello world");
  });

  it("appendThinking is separate from output", () => {
    useV2StreamingStore.getState().appendThinking("s1", "a1", "let me think");
    useV2StreamingStore.getState().appendOutput("s1", "a1", "answer");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams[0].thinkingText).toBe("let me think");
    expect(streams[0].outputText).toBe("answer");
  });

  it("appendThinking merges overlapping reasoning chunks", () => {
    const store = useV2StreamingStore.getState();
    store.appendThinking("s1", "a1", "This");
    store.appendThinking("s1", "a1", "This is");
    store.appendThinking("s1", "a1", " is the");
    store.appendThinking("s1", "a1", " the 8th");
    store.appendThinking("s1", "a1", "8th time");

    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams[0].thinkingText).toBe("This is the 8th time");
  });

  it("keeps thinking segments in ACP event order", () => {
    const store = useV2StreamingStore.getState();
    store.appendThinking("s1", "a1", "Plan first.");
    store.appendOutput("s1", "a1", "Before tool.");
    store.appendThinking("s1", "a1", "Plan second.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "pwd",
      params: { command: "pwd" },
      toolKind: "execute",
    });
    store.appendThinking("s1", "a1", "Plan third.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.thinkingText).toBe("Plan first.Plan second.Plan third.");
    expect(stream.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "text",
      "reasoning",
      "tool-call",
      "reasoning",
    ]);
    expect(stream.parts[0].text).toBe("Plan first.");
    expect(stream.parts[2].text).toBe("Plan second.");
    expect(stream.parts[4].text).toBe("Plan third.");
  });

  it("clearActor removes only that actor", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s1", "a2", "y");
    useV2StreamingStore.getState().clearActor("s1", "a1");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams).toHaveLength(1);
    expect(streams[0].actorId).toBe("a2");
  });

  it("clearSession removes all entries for that session only", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s2", "a1", "y");
    useV2StreamingStore.getState().clearSession("s1");
    const all = useV2StreamingStore.getState().byKey;
    expect(Object.keys(all)).toHaveLength(1);
    expect(all["s2::a1"]).toBeDefined();
  });

  it("selectStreamsForSession ignores other sessions", () => {
    useV2StreamingStore.getState().appendOutput("s1", "a1", "x");
    useV2StreamingStore.getState().appendOutput("s2", "a1", "y");
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")).toHaveLength(1);
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s2")).toHaveLength(1);
  });

  it("archives the prior turn when a new turn starts after finalize", () => {
    const store = useV2StreamingStore.getState();
    // Turn 1: tool + finalize
    store.pushToolUse("s1", "a1", {
      toolId: "t1", toolName: "Bash", description: "ls", params: {}, toolKind: "execute",
    });
    store.finalize("s1", "a1", "turn 1 reply");

    // Turn 2: any new event triggers archival of turn 1
    useV2StreamingStore.getState().appendOutput("s1", "a1", "turn 2 starting");

    const all = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(all).toHaveLength(2);
    // Archived turn 1 keeps its tool call
    const turn1 = all.find((e) => e.toolCalls.length > 0);
    expect(turn1).toBeDefined();
    expect(turn1!.outputText).toBe("turn 1 reply");
    expect(turn1!.active).toBe(false);
    // Current turn 2 has the new output
    const turn2 = all.find((e) => e.outputText === "turn 2 starting");
    expect(turn2).toBeDefined();
    expect(turn2!.active).toBe(true);
  });

  it("keeps live output and tool calls in event order", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "grep",
      description: "search",
      params: {},
      toolKind: "search",
    });
    store.appendOutput("s1", "a1", "After tool.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(stream.parts[0].text).toBe("Before tool.");
    expect(stream.parts[1].toolCall?.id).toBe("tool-1");
    expect(stream.parts[2].text).toBe("After tool.");
  });

  it("merges later toolUse updates into the existing tool call", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "Execute ps command",
      params: {},
      toolKind: "execute",
    });
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.toolCalls).toHaveLength(1);
    expect(stream.parts).toHaveLength(1);
    expect(stream.toolCalls[0].arguments).toMatchObject({
      _description: "Execute ps command",
      command: "ps aux",
    });
    expect(stream.parts[0].toolCall?.arguments).toMatchObject({
      _description: "Execute ps command",
      command: "ps aux",
    });
  });

  it("uses parked agent replies as a live preview without duplicating existing output", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.ingestReplyPreview("s1", "a1", "Before tool.Final answer.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("Before tool.Final answer.");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(stream.parts[0].text).toBe("Before tool.");
    expect(stream.parts[2].text).toBe("Final answer.");

    store.ingestReplyPreview("s1", "a1", "Before tool.Final answer.");
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")[0].parts).toHaveLength(3);
  });

  it("places reply previews after the latest tool when final text is not cumulative", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.ingestReplyPreview("s1", "a1", "Final answer only.");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("Final answer only.");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(stream.parts[0].text).toBe("Before tool.");
    expect(stream.parts[2].text).toBe("Final answer only.");

    store.ingestReplyPreview("s1", "a1", "Final answer only.");
    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")[0].parts).toHaveLength(3);

    store.finalize("s1", "a1", "Updated final answer.");
    const [finalized] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(finalized.active).toBe(false);
    expect(finalized.parts).toHaveLength(3);
    expect(finalized.parts[2].text).toBe("Updated final answer.");
  });

  it("finishSessionActor stops unresolved tool calls from loading", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "grep",
      description: "search",
      params: {},
      toolKind: "search",
    });

    store.finishSessionActor("s1", "a1");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.active).toBe(false);
    expect(stream.toolCalls[0].status).toBe("failed");
    expect(stream.toolCalls[0].result).toBe("Stream ended before this tool returned a result.");
    expect(stream.parts[0].toolCall?.status).toBe("failed");
  });

  it("creates a completed placeholder when tool result arrives without tool use", () => {
    const store = useV2StreamingStore.getState();

    store.completeToolUse("s1", "a1", {
      toolId: "tool-1",
      success: true,
      summary: "done",
    });

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.toolCalls).toHaveLength(1);
    expect(stream.toolCalls[0]).toMatchObject({
      id: "tool-1",
      name: "unknown",
      status: "completed",
      result: "done",
    });
    expect(stream.parts).toHaveLength(1);
    expect(stream.parts[0].toolCall?.status).toBe("completed");
  });

  it("replaceParts updates the live tool result without waiting for session reload", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "Print working directory",
      params: { command: "pwd" },
      toolKind: "execute",
    });
    store.completeToolUse("s1", "a1", {
      toolId: "tool-1",
      success: true,
      summary: "Print working directory",
    });

    store.replaceParts("s1", "a1", [
      {
        id: "stream:tool:tool-1",
        type: "tool-call",
        toolCallId: "tool-1",
        toolCall: {
          id: "tool-1",
          name: "bash",
          toolKind: "execute",
          status: "completed",
          arguments: { command: "pwd", description: "Print working directory" },
          result: "/Users/haigang.ye/project/external/teamclaw-next\n",
          startTime: "2026-05-25T00:00:00.000Z" as unknown as Date,
        },
      },
    ]);

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.toolCalls[0].result).toContain("teamclaw-next");
    expect(stream.parts[0].toolCall?.result).toContain("teamclaw-next");
    expect(stream.parts[0].toolCall?.startTime).toBeInstanceOf(Date);
  });

  it("adds a completed placeholder when a result references an unseen tool in an existing stream", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before.");

    store.completeToolUse("s1", "a1", {
      toolId: "tool-1",
      success: false,
      summary: "failed",
    });

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.parts.map((p) => p.type)).toEqual(["text", "tool-call"]);
    expect(stream.toolCalls[0]).toMatchObject({
      id: "tool-1",
      status: "failed",
      result: "failed",
    });
  });
});
