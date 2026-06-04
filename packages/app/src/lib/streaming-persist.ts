// Persist ordered runtime parts from the in-memory streaming entry onto the
// final AGENT_REPLY row. The daemon persists reply text to Supabase, while
// thinking/tool events are live-only; `parts_json` lets reload restore the
// same text/tool ordering without reconstructing it from synthetic rows.

import { agentReplyTextsEquivalent } from "@/lib/agent-reply-text";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import type { MessagePart } from "@/stores/session-types";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { enrichMessageParts, setMessageParts } from "@/lib/local-cache";
import { useWorkspaceStore } from "@/stores/workspace";

/** Build the canonical ordered parts that should survive a session reload. */
function buildCanonicalPartsFromEntry(
  entry: ReturnType<typeof useV2StreamingStore.getState>["byKey"][string] | undefined,
  reply?: TeamclawMessage,
): MessagePart[] {
  if (!entry) return [];
  const parts: MessagePart[] = [];

  const orderedParts = entry.parts.filter(
    (part) =>
      (part.type === "reasoning" && Boolean(part.text || part.content)) ||
      (part.type === "text" && Boolean(part.text || part.content)) ||
      (part.type === "tool-call" && Boolean(part.toolCall)),
  );
  parts.push(...orderedParts);

  const replyContent = reply?.content?.trim() ? reply.content : "";
  if (
    replyContent &&
    !orderedParts.some(
      (part) =>
        part.type === "text" &&
        agentReplyTextsEquivalent(part.text || part.content || "", replyContent),
    ) &&
    !(entry?.outputText && agentReplyTextsEquivalent(entry.outputText, replyContent))
  ) {
    parts.push({
      id: `${reply.messageId}:text`,
      type: "text",
      text: reply.content,
      content: reply.content,
    });
  }

  return parts;
}

/** Build the canonical ordered parts that should survive a session reload. */
function buildCanonicalParts(
  sessionId: string,
  actorId: string,
  reply: TeamclawMessage,
): MessagePart[] {
  const entry =
    useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
  return buildCanonicalPartsFromEntry(entry, reply);
}

function parsePartsJson(partsJson: string): MessagePart[] {
  try {
    const parts = JSON.parse(partsJson) as MessagePart[];
    return Array.isArray(parts) ? parts : [];
  } catch {
    return [];
  }
}

async function enrichPartsJson(partsJson: string): Promise<string> {
  return enrichMessageParts(partsJson, useWorkspaceStore.getState().workspacePath);
}

export async function syncStreamingToolOutputsFromLocalCache(
  sessionId: string,
  actorId: string,
): Promise<void> {
  const entry =
    useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
  const parts = buildCanonicalPartsFromEntry(entry);
  if (parts.length === 0) return;
  const partsJson = JSON.stringify(parts);
  const enrichedPartsJson = await enrichPartsJson(partsJson);
  if (enrichedPartsJson === partsJson) return;
  const enrichedParts = parsePartsJson(enrichedPartsJson);
  if (enrichedParts.length === 0) return;
  useV2StreamingStore.getState().replaceParts(sessionId, actorId, enrichedParts);
}

/** Called from the live MQTT handler when the turn ends. Pulls thinking,
 * text, and tool calls out of the in-memory streaming entry, attaches them
 * to the final reply as `parts_json`, and persists that blob to libsql. */
export async function persistStreamingPartsForReply(
  sessionId: string,
  actorId: string,
  reply: TeamclawMessage,
): Promise<TeamclawMessage> {
  const turnId = reply.turnId;
  if (!turnId) return reply;
  const parts = buildCanonicalParts(sessionId, actorId, reply);
  if (parts.length === 0) return reply;

  const partsJson = JSON.stringify(parts);
  try {
    const enrichedPartsJson = await setMessageParts(
      reply.messageId,
      partsJson,
      useWorkspaceStore.getState().workspacePath,
    );
    Object.assign(reply, { partsJson: enrichedPartsJson });
    const enrichedParts = parsePartsJson(enrichedPartsJson);
    if (enrichedParts.length > 0) {
      useV2StreamingStore.getState().replaceParts(sessionId, actorId, enrichedParts);
    }
  } catch (e) {
    Object.assign(reply, { partsJson });
    console.warn("[streaming-persist] parts_json write failed:", e);
  }
  return reply;
}
