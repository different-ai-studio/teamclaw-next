import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bufferStreamDelta,
  flushAllStreamDeltas,
  flushStreamDeltasFor,
  __resetStreamDeltaBufferForTests,
} from "@/lib/stream-delta-buffer";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

describe("stream-delta-buffer", () => {
  let rafCallbacks: FrameRequestCallback[];
  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    __resetStreamDeltaBufferForTests();
    useV2StreamingStore.setState({ byKey: {}, archived: [], revisionBySession: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const fireRaf = () => { rafCallbacks.splice(0).forEach((cb) => cb(0)); };
  const entry = () => useV2StreamingStore.getState().byKey["s1::a1"];

  it("coalesces a burst into one store mutation per kind", () => {
    const spy = vi.spyOn(useV2StreamingStore.getState(), "appendOutputBatch");
    bufferStreamDelta("output", "s1", "a1", "alpha ");
    bufferStreamDelta("output", "s1", "a1", "beta ");
    bufferStreamDelta("output", "s1", "a1", "gamma");
    expect(entry()).toBeUndefined();
    fireRaf();
    expect(spy).toHaveBeenCalledTimes(1);
    // byte-identical to N unbatched appendOutput calls: the store folds each
    // delta incrementally, collapsed into a single mutation.
    expect(entry()?.outputText).toBe("alpha beta gamma");
  });

  it("preserves output/thinking interleaving order", () => {
    bufferStreamDelta("thinking", "s1", "a1", "plan…");
    bufferStreamDelta("output", "s1", "a1", "answer");
    fireRaf();
    const parts = entry()!.parts;
    expect(parts[0].type).toBe("reasoning");
    expect(parts[1].type).toBe("text");
  });

  it("flushStreamDeltasFor applies synchronously for that key only", () => {
    bufferStreamDelta("output", "s1", "a1", "A");
    bufferStreamDelta("output", "s2", "a2", "B");
    flushStreamDeltasFor("s1", "a1");
    expect(entry()?.outputText).toBe("A");
    expect(useV2StreamingStore.getState().byKey["s2::a2"]).toBeUndefined();
    flushAllStreamDeltas();
    expect(useV2StreamingStore.getState().byKey["s2::a2"]?.outputText).toBe("B");
  });

  it("keeps overlap dedup across buffered chunks", () => {
    bufferStreamDelta("output", "s1", "a1", "abcdef");
    bufferStreamDelta("output", "s1", "a1", "defghi");
    fireRaf();
    expect(entry()?.outputText).toBe("abcdefghi");
  });

  it("matches unbatched fold when a run overlaps existing tail (no silent drop)", () => {
    // seed existing entry text via a prior committed delta
    useV2StreamingStore.getState().appendOutput("s1", "a1", "The over");
    bufferStreamDelta("output", "s1", "a1", "The");
    bufferStreamDelta("output", "s1", "a1", " over");
    fireRaf();
    // unbatched fold: overlap("The over","The")="The overThe", then +" over"="The overThe over"
    expect(entry()?.outputText).toBe("The overThe over");
  });
});
