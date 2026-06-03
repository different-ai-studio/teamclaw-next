import { describe, expect, it, vi } from "vitest";

import { syncSessionRuntimeModelIfNeeded } from "../session-runtime-model-sync";

describe("syncSessionRuntimeModelIfNeeded", () => {
  it("applies immediately when a session model is selected for the first time", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);

    const nextKey = await syncSessionRuntimeModelIfNeeded({
      sessionId: "sess-1",
      modelId: "scnet/MiniMax-M2.5",
      lastAppliedKey: null,
      apply,
    });

    expect(apply).toHaveBeenCalledWith({
      sessionId: "sess-1",
      agentActorIds: [],
      modelId: "scnet/MiniMax-M2.5",
    });
    expect(nextKey).toBe("sess-1::scnet/MiniMax-M2.5");
  });

  it("skips duplicate apply when the session/model pair is unchanged", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);

    const nextKey = await syncSessionRuntimeModelIfNeeded({
      sessionId: "sess-1",
      modelId: "scnet/MiniMax-M2.5",
      lastAppliedKey: "sess-1::scnet/MiniMax-M2.5",
      apply,
    });

    expect(apply).not.toHaveBeenCalled();
    expect(nextKey).toBe("sess-1::scnet/MiniMax-M2.5");
  });

  it("re-applies when the selected model changes", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);

    const nextKey = await syncSessionRuntimeModelIfNeeded({
      sessionId: "sess-1",
      modelId: "openai/gpt-5.2",
      lastAppliedKey: "sess-1::scnet/MiniMax-M2.5",
      apply,
    });

    expect(apply).toHaveBeenCalledWith({
      sessionId: "sess-1",
      agentActorIds: [],
      modelId: "openai/gpt-5.2",
    });
    expect(nextKey).toBe("sess-1::openai/gpt-5.2");
  });

  it("clears the tracking key when session or model is missing", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);

    const nextKey = await syncSessionRuntimeModelIfNeeded({
      sessionId: null,
      modelId: "openai/gpt-5.2",
      lastAppliedKey: "sess-1::scnet/MiniMax-M2.5",
      apply,
    });

    expect(apply).not.toHaveBeenCalled();
    expect(nextKey).toBeNull();
  });
});
