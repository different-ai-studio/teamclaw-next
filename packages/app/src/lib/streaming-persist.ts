// Persist ordered runtime parts from the in-memory streaming entry onto the
// final AGENT_REPLY row. The daemon persists reply text to Supabase, while
// thinking/tool events are live-only; `parts_json` lets reload restore the
// same text/tool ordering without reconstructing it from synthetic rows.

import {
  deriveAgentReplyContent,
  joinTextPartsFromParts,
} from "@/lib/agent-reply-transcript";
import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import type { MessagePart } from "@/stores/session-types";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { enrichMessageParts, setMessageParts } from "@/lib/local-cache";
import { useWorkspaceStore } from "@/stores/workspace";

/** Snapshot live transcript parts — the only canonical source for parts_json. */
function snapshotTranscriptParts(
  entry: ReturnType<typeof useV2StreamingStore.getState>["byKey"][string] | undefined,
): MessagePart[] {
  if (!entry) return [];
  return entry.parts.filter(
    (part) =>
      (part.type === "reasoning" && Boolean(part.text || part.content)) ||
      (part.type === "text" && Boolean(part.text || part.content)) ||
      (part.type === "tool-call" && Boolean(part.toolCall)),
  );
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
  const parts = snapshotTranscriptParts(entry);
  if (parts.length === 0) return;
  const partsJson = JSON.stringify(parts);
  const enrichedPartsJson = await enrichPartsJson(partsJson);
  if (enrichedPartsJson === partsJson) return;
  const enrichedParts = parsePartsJson(enrichedPartsJson);
  if (enrichedParts.length === 0) return;
  useV2StreamingStore.getState().replaceParts(sessionId, actorId, enrichedParts);
}

/** Called from the live MQTT handler when the turn ends. Snapshots live parts[]
 * onto the final reply as `parts_json` and persists that blob to libsql. */
export async function persistStreamingPartsForReply(
  sessionId: string,
  actorId: string,
  reply: TeamclawMessage,
  pendingReplies: TeamclawMessage[] = [],
): Promise<TeamclawMessage> {
  const turnId = reply.turnId;
  if (!turnId) return reply;
  const entry =
    useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
  const parts = snapshotTranscriptParts(entry);
  if (parts.length === 0) return reply;

  const content = deriveAgentReplyContent(parts, pendingReplies.length > 0 ? pendingReplies : [reply]);
  Object.assign(reply, { content });

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

/** @internal test helper */
export function transcriptPartsForTests(
  parts: MessagePart[],
  pending: TeamclawMessage[],
): { parts: MessagePart[]; content: string } {
  return {
    parts,
    content: deriveAgentReplyContent(parts, pending),
  };
}

export { joinTextPartsFromParts };
