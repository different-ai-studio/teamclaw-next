import { describe, expect, it } from "vitest";
import { AgentStatus } from "@/lib/proto/amux_pb";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import {
  PENDING_AGENT_REPLY_FALLBACK_MS,
  PENDING_AGENT_REPLY_HARD_TIMEOUT_MS,
  PENDING_AGENT_REPLY_TOOL_GRACE_MS,
  isAgentActiveStatus,
  isTerminalAgentStatus,
  mergePendingAgentReplies,
  normalizeToolResultEvent,
  normalizeToolUseEvent,
  rememberLiveEventId,
  streamEntryHasVisibleContent,
  shouldFlushPendingAgentReplyFallback,
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

  it("does not flush a parked reply before the fallback grace window", () => {
    expect(
      shouldFlushPendingAgentReplyFallback(
        { toolCalls: [] },
        1_000 + PENDING_AGENT_REPLY_FALLBACK_MS - 1,
        1_000,
      ),
    ).toBe(false);
  });

  it("keeps parked replies hidden while a tool is still running", () => {
    expect(
      shouldFlushPendingAgentReplyFallback(
        { toolCalls: [{ status: "calling" }] },
        1_000 + PENDING_AGENT_REPLY_FALLBACK_MS,
        1_000,
      ),
    ).toBe(false);
    expect(
      shouldFlushPendingAgentReplyFallback(
        { toolCalls: [{ status: "waiting" }] },
        1_000 + PENDING_AGENT_REPLY_FALLBACK_MS,
        1_000,
      ),
    ).toBe(false);
    expect(
      shouldFlushPendingAgentReplyFallback(
        { toolCalls: [{ id: "tool-1", status: "calling" }] },
        1_000 + PENDING_AGENT_REPLY_TOOL_GRACE_MS + 1,
        1_000,
      ),
    ).toBe(false);
  });

  it("flushes a parked reply after a hard timeout even if a tool result was missed", () => {
    expect(
      shouldFlushPendingAgentReplyFallback(
        { toolCalls: [{ id: "tool-1", status: "calling" }] },
        1_000 + PENDING_AGENT_REPLY_HARD_TIMEOUT_MS,
        1_000,
      ),
    ).toBe(true);
  });

  it("flushes a parked reply when final text appears after an active tool", () => {
    const entry = {
      toolCalls: [{ id: "tool-1", status: "calling" }],
      parts: [
        { type: "text", text: "Before tool." },
        { type: "tool-call", toolCallId: "tool-1" },
        { type: "text", text: "Final answer." },
      ],
    };

    expect(
      shouldFlushPendingAgentReplyFallback(
        entry,
        1_000 + PENDING_AGENT_REPLY_FALLBACK_MS,
        1_000,
      ),
    ).toBe(false);

    expect(
      shouldFlushPendingAgentReplyFallback(
        entry,
        1_000 + PENDING_AGENT_REPLY_TOOL_GRACE_MS,
        1_000,
      ),
    ).toBe(true);
  });

  it("flushes a parked reply after grace when no tool is still active", () => {
    expect(
      shouldFlushPendingAgentReplyFallback(
        { toolCalls: [] },
        1_000 + PENDING_AGENT_REPLY_FALLBACK_MS,
        1_000,
      ),
    ).toBe(true);
    expect(
      shouldFlushPendingAgentReplyFallback(
        { toolCalls: [{ status: "completed" }, { status: "failed" }] },
        1_000 + PENDING_AGENT_REPLY_FALLBACK_MS,
        1_000,
      ),
    ).toBe(true);
    expect(
      shouldFlushPendingAgentReplyFallback(
        undefined,
        1_000 + PENDING_AGENT_REPLY_FALLBACK_MS,
        1_000,
      ),
    ).toBe(true);
  });

  it("dedupes repeated live event ids per session", () => {
    const seen = new Set<string>();
    expect(rememberLiveEventId(seen, "s1", "evt-1")).toBe(true);
    expect(rememberLiveEventId(seen, "s1", "evt-1")).toBe(false);
    expect(rememberLiveEventId(seen, "s2", "evt-1")).toBe(true);
  });

  it("merges parked agent replies using stream outputText", () => {
    const pending = [
      { messageId: "m1", content: "CPU Top 3" },
      { messageId: "m2", content: "Memory Top 3" },
    ] as TeamclawMessage[];
    expect(
      mergePendingAgentReplies(pending, {
        outputText: "CPU Top 3\n\nMemory Top 3",
      })?.content,
    ).toBe("CPU Top 3\n\nMemory Top 3");
  });

  it("joins distinct parked chunks when stream outputText is empty", () => {
    const pending = [
      { messageId: "m1", content: "CPU Top 3" },
      { messageId: "m2", content: "Memory Top 3" },
    ] as TeamclawMessage[];
    expect(mergePendingAgentReplies(pending)?.content).toBe(
      "CPU Top 3\n\nMemory Top 3",
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
        outputText: "answer",
        thinkingText: "",
        toolCalls: [],
        parts: [],
      }),
    ).toBe(true);
  });
});
