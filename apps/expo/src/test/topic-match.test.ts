import { describe, expect, it } from "vitest";
import { topicMatches, extractWildcards } from "../lib/mqtt/topic-match";

describe("topicMatches", () => {
  it("matches exact topics", () => {
    expect(topicMatches("amux/t/session/s/live", "amux/t/session/s/live")).toBe(true);
  });
  it("matches single-level wildcard", () => {
    expect(topicMatches("amux/t/device/d/runtime/+/state",
                        "amux/t/device/d/runtime/r1/state")).toBe(true);
  });
  it("rejects when segment count differs", () => {
    expect(topicMatches("amux/t/device/+/runtime/+",
                        "amux/t/device/d/runtime/r/state")).toBe(false);
  });
  it("matches multi-level wildcard", () => {
    expect(topicMatches("amux/t/#", "amux/t/device/d/runtime/r/state")).toBe(true);
  });
  it("multi-level wildcard requires at least one segment", () => {
    expect(topicMatches("amux/t/#", "amux/t")).toBe(false);
  });
});

describe("extractWildcards", () => {
  it("extracts segment values matched by + wildcards in order", () => {
    expect(
      extractWildcards(
        "amux/+/device/+/runtime/+/state",
        "amux/teamA/device/devB/runtime/rtC/state",
      ),
    ).toEqual(["teamA", "devB", "rtC"]);
  });
  it("returns null when topic does not match", () => {
    expect(
      extractWildcards("amux/+/x", "amux/a/b/c"),
    ).toBe(null);
  });
});
