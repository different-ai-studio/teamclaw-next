import { create as createMessage } from "@bufbuild/protobuf";
import { AgentStatus } from "@/lib/proto/amux_pb";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclaw_pb";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { deriveAgentReplyContent } from "@/lib/agent-reply-transcript";
import { agentReplyTextsEquivalent } from "@/lib/agent-reply-text";

export {
  deriveAgentReplyContent,
  joinTextPartsFromParts,
} from "@/lib/agent-reply-transcript";
import { resolveWireToolName } from "@/components/chat/tool-calls/tool-call-utils";

export function agentStreamKey(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
}

let discardPendingStreamReplyHandler:
  | ((sessionId: string, actorId: string) => void)
  | null = null;

/** App registers a handler to drop parked AGENT_REPLY rows without persisting. */
export function registerDiscardPendingStreamReply(
  handler: ((sessionId: string, actorId: string) => void) | null,
): void {
  discardPendingStreamReplyHandler = handler;
}

export function discardPendingStreamReply(sessionId: string, actorId: string): void {
  discardPendingStreamReplyHandler?.(sessionId, actorId);
}

const SEEN_LIVE_EVENT_IDS_CAP = 2_000;

/** Dedupe MQTT live envelopes that may be redelivered with the same eventId. */
export function rememberLiveEventId(
  seen: Set<string>,
  sessionId: string,
  eventId: string | undefined,
): boolean {
  if (!eventId) return true;
  const key = `${sessionId}::${eventId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_LIVE_EVENT_IDS_CAP) {
    const oldest = seen.values().next().value;
    if (oldest) seen.delete(oldest);
  }
  return true;
}

/** Join mid-turn daemon AgentReply slices without duplicating overlapping text. */
export function joinDistinctPendingReplyChunks(pending: TeamclawMessage[]): string {
  const chunks: string[] = [];
  for (const message of pending) {
    const text = message.content?.trim();
    if (!text) continue;
    const previous = chunks[chunks.length - 1];
    if (!previous) {
      chunks.push(text);
      continue;
    }
    if (text === previous || agentReplyTextsEquivalent(text, previous)) continue;
    if (previous.includes(text) || agentReplyTextsEquivalent(previous, text)) continue;
    if (text.includes(previous)) {
      chunks[chunks.length - 1] = text;
      continue;
    }
    chunks.push(text);
  }
  return chunks.join("\n\n");
}

/**
 * Pick the persisted AGENT_REPLY row from parked daemon slices.
 * Body text comes from the live transcript (parts[]), not from merge heuristics.
 */
export function mergePendingAgentReplies(
  pending: TeamclawMessage[],
  streamEntry?: StreamVisibilityEntry,
): TeamclawMessage | null {
  if (pending.length === 0) return null;
  const last = pending[pending.length - 1];
  const content = deriveAgentReplyContent(streamEntry?.parts ?? [], pending);
  if (!content.trim() && !streamEntryHasVisibleContent(streamEntry)) return null;
  return { ...last, content };
}

/** Client-side anchor when daemon terminal arrives before agent_reply (interrupt + tool). */
export function buildInterruptedStreamAnchor(
  sessionId: string,
  actorId: string,
  snapshot: AgentStreamEntry,
): TeamclawMessage {
  const createdAtMs =
    snapshot.toolCalls[0]?.startTime?.getTime?.() ??
    snapshot.lastUpdate ??
    Date.now();
  return createMessage(MessageSchema, {
    messageId: `interrupt-${snapshot.streamId}`,
    sessionId,
    senderActorId: actorId,
    kind: MessageKind.AGENT_REPLY,
    content: "",
    turnId: `interrupt-${snapshot.streamId}`,
    createdAt: BigInt(Math.max(1, Math.floor(createdAtMs / 1000))),
  });
}

/** Daemon emits an empty AGENT_REPLY anchor when a tool-only turn ends (e.g. cancel). */
export function isToolOnlyTurnAnchor(
  pending: TeamclawMessage[],
  streamEntry?: StreamVisibilityEntry,
): boolean {
  const merged = mergePendingAgentReplies(pending, streamEntry);
  if (!merged) return false;
  return !merged.content.trim() && streamEntryHasVisibleContent(streamEntry);
}

type StreamVisibilityEntry = {
  outputText?: string;
  thinkingText?: string;
  toolCalls?: Array<unknown>;
  parts?: Array<{
    type?: string;
    text?: string;
    content?: string;
    toolCall?: unknown;
  }>;
  pendingPermission?: unknown;
};

export function streamEntryHasVisibleContent(
  entry: StreamVisibilityEntry | undefined,
): boolean {
  if (!entry) return false;
  if (entry.outputText?.trim()) return true;
  if (entry.thinkingText?.trim()) return true;
  if (entry.pendingPermission) return true;
  if ((entry.toolCalls?.length ?? 0) > 0) return true;
  return (entry.parts ?? []).some((part) => {
    if (part.type === "tool-call") return Boolean(part.toolCall);
    return Boolean(part.text?.trim() || part.content?.trim());
  });
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function paramsField(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
    else if (raw !== undefined && raw !== null) out[key] = String(raw);
  }
  return out;
}

function parseJsonObject(value: string): Record<string, string> {
  if (!value.trim().startsWith("{")) return {};
  try {
    return paramsField(JSON.parse(value));
  } catch {
    return {};
  }
}

function recordFromValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeToolUseEvent(value: unknown): {
  toolId: string;
  toolName: string;
  description: string;
  params: Record<string, string>;
  toolKind?: string;
} {
  const raw = recordFromValue(value);
  const description = stringField(raw, "description");
  const params = {
    ...parseJsonObject(description),
    ...paramsField(raw.params),
  };
  const toolKind = stringField(raw, "toolKind", "tool_kind");
  const explicitToolName = stringField(raw, "toolName", "tool_name");
  const resolveParams = { ...params };
  if (description && !resolveParams.description) {
    resolveParams.description = description;
  }
  return {
    toolId: stringField(raw, "toolId", "tool_id"),
    toolName:
      resolveWireToolName(toolKind, explicitToolName || "unknown", resolveParams),
    description,
    params,
    toolKind: toolKind || undefined,
  };
}

export function normalizeToolResultEvent(value: unknown): {
  toolId: string;
  success: boolean;
  summary: string;
} {
  const raw = recordFromValue(value);
  const success = raw.success === true || raw.success === "true";
  return {
    toolId: stringField(raw, "toolId", "tool_id"),
    success,
    summary: stringField(raw, "summary"),
  };
}

export function isTerminalAgentStatus(status: AgentStatus | number | undefined): boolean {
  return (
    status === AgentStatus.IDLE ||
    status === AgentStatus.ERROR ||
    status === AgentStatus.STOPPED
  );
}

/** Daemon emits `statusChange` with `newStatus=ACTIVE` when a prompt turn starts. */
export function isAgentActiveStatus(status: AgentStatus | number | undefined): boolean {
  return status === AgentStatus.ACTIVE;
}
