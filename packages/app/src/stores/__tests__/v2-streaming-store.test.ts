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
  });

  it("appendThinking is separate from output", () => {
    useV2StreamingStore.getState().appendThinking("s1", "a1", "let me think");
    useV2StreamingStore.getState().appendOutput("s1", "a1", "answer");
    const streams = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    expect(streams[0].thinkingText).toBe("let me think");
    expect(streams[0].outputText).toBe("answer");
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
});
