import { describe, expect, it } from "vitest";
import {
  agentReplyTextsEquivalent,
  normalizeAgentReplyText,
  pickCanonicalAgentReplyText,
} from "@/lib/agent-reply-text";

describe("agentReplyTextsEquivalent", () => {
  it("treats whitespace-only differences as equivalent", () => {
    const a = "Hello DeepSeek world.";
    const b = "Hello DeepSeek  world.";
    expect(agentReplyTextsEquivalent(a, b)).toBe(true);
    expect(normalizeAgentReplyText(a)).toBe(normalizeAgentReplyText(b));
  });

  it("picks the longer canonical body", () => {
    expect(pickCanonicalAgentReplyText("ab", "ab ")).toBe("ab ");
  });

  it("does not equate genuinely different segments", () => {
    expect(agentReplyTextsEquivalent("CPU Top 3", "Memory Top 3")).toBe(false);
  });

  it("does not equate prefix + new post-tool segment", () => {
    expect(
      agentReplyTextsEquivalent("Before tool.", "Before tool.Final answer."),
    ).toBe(false);
  });
});
