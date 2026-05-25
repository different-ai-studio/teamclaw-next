import { AgentStatus } from "@/lib/proto/amux_pb";

export const PENDING_AGENT_REPLY_FALLBACK_MS = 1_200;
export const PENDING_AGENT_REPLY_TOOL_GRACE_MS = 3_000;
export const PENDING_AGENT_REPLY_HARD_TIMEOUT_MS = 8_000;

export function agentStreamKey(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
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

function toolNameFromKind(kind: string): string {
  switch (kind) {
    case "execute":
      return "bash";
    case "search":
      return "grep";
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "fetch":
      return "web_search";
    case "delete":
      return "delete";
    case "move":
      return "move";
    case "think":
      return "think";
    default:
      return "";
  }
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
  return {
    toolId: stringField(raw, "toolId", "tool_id"),
    toolName: explicitToolName || toolNameFromKind(toolKind) || "unknown",
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

type PendingReplyStreamLike = {
  toolCalls?: Array<{ id?: string; status?: string }>;
  parts?: Array<{
    type?: string;
    text?: string;
    content?: string;
    toolCallId?: string;
    toolCall?: { id?: string; status?: string };
  }>;
};

function isActiveToolStatus(status: string | undefined): boolean {
  return status === "calling" || status === "waiting";
}

function hasTextAfterActiveTool(entry: PendingReplyStreamLike): boolean {
  const activeToolIds = new Set(
    (entry.toolCalls ?? [])
      .filter((toolCall) => isActiveToolStatus(toolCall.status))
      .map((toolCall) => toolCall.id)
      .filter(Boolean),
  );
  if (activeToolIds.size === 0) return false;

  let sawActiveTool = false;
  for (const part of entry.parts ?? []) {
    if (part.type === "tool-call") {
      const partToolId = part.toolCallId || part.toolCall?.id;
      const partToolActive =
        (partToolId && activeToolIds.has(partToolId)) ||
        isActiveToolStatus(part.toolCall?.status);
      if (partToolActive) sawActiveTool = true;
      continue;
    }
    if (
      sawActiveTool &&
      part.type === "text" &&
      Boolean(part.text || part.content)
    ) {
      return true;
    }
  }
  return false;
}

export function shouldFlushPendingAgentReplyFallback(
  entry: PendingReplyStreamLike | undefined,
  now: number,
  pendingSince: number,
  graceMs = PENDING_AGENT_REPLY_FALLBACK_MS,
  toolGraceMs = PENDING_AGENT_REPLY_TOOL_GRACE_MS,
  hardTimeoutMs = PENDING_AGENT_REPLY_HARD_TIMEOUT_MS,
): boolean {
  const elapsed = now - pendingSince;
  if (elapsed < graceMs) return false;
  if (elapsed >= hardTimeoutMs) return true;
  if (!entry) return true;
  const hasActiveTool = (entry.toolCalls ?? []).some((toolCall) =>
    isActiveToolStatus(toolCall.status),
  );
  if (!hasActiveTool) return true;
  return elapsed >= toolGraceMs && hasTextAfterActiveTool(entry);
}
