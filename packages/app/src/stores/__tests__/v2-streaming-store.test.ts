import { describe, it, expect, beforeEach } from "vitest";
import {
  isStreamInterruptible,
  useV2StreamingStore,
  selectStreamsForSession,
} from "../v2-streaming-store";

beforeEach(() => {
  // Reset to a clean state
  useV2StreamingStore.setState({ byKey: {}, archived: [], persistedPlansBySession: {} });
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

  it("appendOutput merges cumulative snapshot chunks", () => {
    const store = useV2StreamingStore.getState();
    for (const chunk of [
      "/Users",
      "/Users/haigang",
      "/Users/haigang.ye/project/external/teamclaw-next",
    ]) {
      store.appendOutput("s1", "a1", chunk);
    }
    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("/Users/haigang.ye/project/external/teamclaw-next");
    expect(stream.parts[0].text).toBe("/Users/haigang.ye/project/external/teamclaw-next");
  });

  it("appendOutput tolerates duplicate delivery of the same chunks", () => {
    const store = useV2StreamingStore.getState();
    for (const chunk of ["/Users", "/ha", "igang", ".ye"]) {
      store.appendOutput("s1", "a1", chunk);
      store.appendOutput("s1", "a1", chunk);
    }
    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toBe("/Users/haigang.ye");
    expect(stream.parts[0].text).toBe("/Users/haigang.ye");
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

  it("appends distinct reply preview segments after tool calls", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.ingestReplyPreview("s1", "a1", "CPU Top 3:\n1. foo");
    store.ingestReplyPreview("s1", "a1", "Memory Top 3:\n1. bar");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.outputText).toContain("CPU Top 3");
    expect(stream.outputText).toContain("Memory Top 3");
    expect(stream.parts.map((p) => p.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "text",
    ]);
    expect(stream.parts[2].text).toContain("CPU Top 3");
    expect(stream.parts[3].text).toContain("Memory Top 3");
  });

  it("finalize collapses multiple post-tool preview text parts into one", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Before tool.");
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });
    store.ingestReplyPreview("s1", "a1", "CPU Top 3:\n1. foo");
    store.ingestReplyPreview("s1", "a1", "Memory Top 3:\n1. bar");

    store.finalize("s1", "a1", "CPU Top 3:\n1. foo\n\nMemory Top 3:\n1. bar");

    const [finalized] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(finalized.active).toBe(false);
    expect(finalized.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
    expect(finalized.parts[2].text).toBe(
      "CPU Top 3:\n1. foo\n\nMemory Top 3:\n1. bar",
    );
  });

  it("releaseActorAfterPersist skipArchive only drops archived rows for the current streamId", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });
    const firstStreamId = useV2StreamingStore.getState().byKey["s1::a1"].streamId;
    store.releaseActorAfterPersist("s1", "a1");
    expect(useV2StreamingStore.getState().archived).toHaveLength(1);
    expect(useV2StreamingStore.getState().archived[0].streamId).toBe(firstStreamId);

    store.pushToolUse("s1", "a1", {
      toolId: "tool-2",
      toolName: "bash",
      description: "df",
      params: { command: "df -h" },
      toolKind: "execute",
    });
    const secondStreamId = useV2StreamingStore.getState().byKey["s1::a1"].streamId;
    expect(secondStreamId).not.toBe(firstStreamId);

    store.releaseActorAfterPersist("s1", "a1", {
      persistedPartsJson: JSON.stringify([
        { id: "t2", type: "tool-call", toolCallId: "tool-2", toolCall: { id: "tool-2" } },
      ]),
    });

    expect(useV2StreamingStore.getState().archived).toHaveLength(1);
    expect(useV2StreamingStore.getState().archived[0].streamId).toBe(firstStreamId);
  });

  it("releaseActorAfterPersist skips archive when parts_json already has tools", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });

    store.releaseActorAfterPersist("s1", "a1", {
      persistedPartsJson: JSON.stringify([
        { id: "t1", type: "tool-call", toolCallId: "tool-1", toolCall: { id: "tool-1" } },
      ]),
    });

    const state = useV2StreamingStore.getState();
    expect(state.byKey["s1::a1"]).toBeUndefined();
    expect(state.archived).toHaveLength(0);
    expect(selectStreamsForSession(state, "s1")).toHaveLength(0);
  });

  it("releaseActorAfterPersist archives tool calls when parts_json did not persist them", () => {
    const store = useV2StreamingStore.getState();
    store.pushToolUse("s1", "a1", {
      toolId: "tool-1",
      toolName: "bash",
      description: "ps",
      params: { command: "ps aux" },
      toolKind: "execute",
    });
    store.appendOutput("s1", "a1", "Done.");

    store.releaseActorAfterPersist("s1", "a1");

    const state = useV2StreamingStore.getState();
    expect(state.byKey["s1::a1"]).toBeUndefined();
    expect(state.archived).toHaveLength(1);
    expect(state.archived[0].toolCalls).toHaveLength(1);
    expect(state.archived[0].parts.some((part) => part.type === "tool-call")).toBe(true);
    expect(selectStreamsForSession(state, "s1")).toHaveLength(1);
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

  it("markActorStreamActive re-opens a stream after finishSessionActor", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Hello");
    store.finishSessionActor("s1", "a1");

    expect(useV2StreamingStore.getState().byKey["s1::a1"].active).toBe(false);

    store.markActorStreamActive("s1", "a1");
    store.appendOutput("s1", "a1", " world");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.active).toBe(true);
    expect(stream.outputText).toBe("Hello world");
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

  it("treats errored streams as visible but not interruptible", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "a1", "Partial output");
    store.setError("s1", "a1", "No output", "Model misconfigured");

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.active).toBe(true);
    expect(stream.errorMessage).toBe("No output");
    expect(isStreamInterruptible(stream)).toBe(false);
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

  it("keeps persisted session plan after clearActor removes the live stream", () => {
    const store = useV2StreamingStore.getState();
    store.setPlan("s1", "a1", [
      { content: "Task one", priority: "high", status: "in_progress" },
      { content: "Task two", priority: "medium", status: "pending" },
    ]);
    store.clearActor("s1", "a1");

    expect(selectStreamsForSession(useV2StreamingStore.getState(), "s1")).toHaveLength(0);
    expect(useV2StreamingStore.getState().persistedPlansBySession.s1?.planEntries).toHaveLength(2);
  });

  it("keeps the latest non-empty plan when an empty update arrives", () => {
    const store = useV2StreamingStore.getState();
    store.setPlan("s1", "a1", [
      { content: "Analyze requirements", priority: "high", status: "in_progress" },
      { content: "Write tests", priority: "medium", status: "pending" },
    ]);

    store.setPlan("s1", "a1", []);

    const [stream] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(stream.planEntries).toHaveLength(2);
    expect(stream.planEntries[0].content).toBe("Analyze requirements");
    expect(stream.planEntries[1].content).toBe("Write tests");
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
