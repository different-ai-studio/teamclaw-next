import { describe, expect, it } from "vitest";
import { AgentStatus } from "@/lib/proto/amux_pb";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import {
  isAgentActiveStatus,
  isTerminalAgentStatus,
  joinDistinctPendingReplyChunks,
  mergePendingAgentReplies,
  normalizeToolResultEvent,
  normalizeToolUseEvent,
  rememberLiveEventId,
  streamEntryHasVisibleContent,
} from "@/lib/live-agent-stream";

describe("live agent stream event helpers", () => {
  it("normalizes execute tool uses into command tool calls", () => {
    expect(
      normalizeToolUseEvent({
        tool_id: "tool-1",
        tool_kind: "execute",
        description: '{"command":"ps aux"}',
      }),
    ).toEqual({
      toolId: "tool-1",
      toolName: "bash",
      description: '{"command":"ps aux"}',
      params: { command: "ps aux" },
      toolKind: "execute",
    });
  });

  it("maps other-kind skill tool uses to the skill route", () => {
    expect(
      normalizeToolUseEvent({
        tool_id: "tool-skill",
        tool_name: "other",
        tool_kind: "other",
        description: "skill",
        params: { name: "brainstorming", description: "skill" },
      }),
    ).toEqual({
      toolId: "tool-skill",
      toolName: "skill",
      description: "skill",
      params: { name: "brainstorming", description: "skill" },
      toolKind: "other",
    });
  });

  it("keeps explicit params when description is only a title", () => {
    expect(
      normalizeToolUseEvent({
        toolId: "tool-1",
        toolName: "Execute ps command",
        toolKind: "execute",
        description: "Execute ps command",
        params: { command: "ps aux", description: "Execute ps command" },
      }),
    ).toEqual({
      toolId: "tool-1",
      toolName: "bash",
      description: "Execute ps command",
      params: { command: "ps aux", description: "Execute ps command" },
      toolKind: "execute",
    });
  });

  it("normalizes camelCase tool result fields", () => {
    expect(
      normalizeToolResultEvent({
        toolId: "tool-1",
        success: "true",
        summary: "done",
      }),
    ).toEqual({
      toolId: "tool-1",
      success: true,
      summary: "done",
    });
  });

  it("recognizes terminal agent statuses", () => {
    expect(isTerminalAgentStatus(AgentStatus.IDLE)).toBe(true);
    expect(isTerminalAgentStatus(AgentStatus.ERROR)).toBe(true);
    expect(isTerminalAgentStatus(AgentStatus.STOPPED)).toBe(true);
    expect(isTerminalAgentStatus(AgentStatus.ACTIVE)).toBe(false);
  });

  it("recognizes active agent status for planning placeholder", () => {
    expect(isAgentActiveStatus(AgentStatus.ACTIVE)).toBe(true);
    expect(isAgentActiveStatus(AgentStatus.IDLE)).toBe(false);
    expect(isAgentActiveStatus(2)).toBe(true);
  });

  it("dedupes repeated live event ids per session", () => {
    const seen = new Set<string>();
    expect(rememberLiveEventId(seen, "s1", "evt-1")).toBe(true);
    expect(rememberLiveEventId(seen, "s1", "evt-1")).toBe(false);
    expect(rememberLiveEventId(seen, "s2", "evt-1")).toBe(true);
  });

  it("derives merged content from transcript parts when present", () => {
    const pending = [
      { messageId: "m1", content: "CPU Top 3" },
      { messageId: "m2", content: "Memory Top 3" },
    ] as TeamclawMessage[];
    expect(
      mergePendingAgentReplies(pending, {
        parts: [
          { type: "text", text: "CPU Top 3" },
          { type: "tool-call", toolCall: { id: "t1" } },
          { type: "text", text: "Memory Top 3" },
        ],
      })?.content,
    ).toBe("CPU Top 3\n\nMemory Top 3");
  });

  it("falls back to joined pending when transcript has no text parts", () => {
    const pending = [
      { messageId: "m1", content: "CPU Top 3" },
      { messageId: "m2", content: "Memory Top 3" },
    ] as TeamclawMessage[];
    expect(mergePendingAgentReplies(pending)?.content).toBe(
      "CPU Top 3\n\nMemory Top 3",
    );
  });

  it("reconciles single-segment typo drift from daemon final slice", () => {
    const stream =
      "好的，我整理了两种方案：\n\n**方案 A** 单文件。\n\n**方案 B** React。\n\n**我推荐方案 A**——够用。适合之后想再改、加点功能。你觉得呢？";
    const daemon = stream.replace("再改、", "再改改、");
    const pending = [{ messageId: "m1", content: daemon }] as TeamclawMessage[];
    const merged = mergePendingAgentReplies(pending, {
      parts: [{ type: "text", text: stream }],
    });
    expect(merged?.content).toBe(daemon);
    expect(merged?.content).not.toContain(`${daemon}\n\n${stream}`);
  });

  it("joinDistinctPendingReplyChunks merges non-overlapping slices", () => {
    const pending = [
      { messageId: "m1", content: "First part." },
      { messageId: "m2", content: "Second part." },
    ] as TeamclawMessage[];
    expect(joinDistinctPendingReplyChunks(pending)).toBe(
      "First part.\n\nSecond part.",
    );
  });

  it("treats parked empty agent replies as no reply", () => {
    const pending = [
      { messageId: "m1", content: "" },
      { messageId: "m2", content: "   " },
    ] as TeamclawMessage[];
    expect(mergePendingAgentReplies(pending)).toBeNull();
  });

  it("detects when a stream ended without any visible content", () => {
    expect(streamEntryHasVisibleContent(undefined)).toBe(false);
    expect(
      streamEntryHasVisibleContent({
        outputText: " ",
        thinkingText: "",
        toolCalls: [],
        parts: [],
      }),
    ).toBe(false);
    expect(
      streamEntryHasVisibleContent({
        outputText: "",
        thinkingText: "",
        toolCalls: [{ id: "tool-1" }],
        parts: [],
      }),
    ).toBe(true);
    expect(
      streamEntryHasVisibleContent({
        outputText: "",
        thinkingText: "",
        toolCalls: [],
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toBe(true);
  });
});
