// Persist ordered runtime parts from the in-memory streaming entry onto the
// final AGENT_REPLY row. The daemon persists reply text to Supabase, while
// thinking/tool events are live-only; `parts_json` lets reload restore the
// same text/tool ordering without reconstructing it from synthetic rows.

import type { Message as TeamclawMessage } from "@/lib/proto/teamclaw_pb";
import type { MessagePart } from "@/stores/session-types";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { setMessageParts } from "@/lib/local-cache";

/** Build the canonical ordered parts that should survive a session reload. */
function buildCanonicalParts(
  sessionId: string,
  actorId: string,
  reply: TeamclawMessage,
): MessagePart[] {
  const entry =
    useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
  if (!entry) return [];
  const parts: MessagePart[] = [];

  if (entry.thinkingText) {
    parts.push({
      id: `${reply.messageId}:reasoning`,
      type: "reasoning",
      text: entry.thinkingText,
      content: entry.thinkingText,
    });
  }

  const orderedParts = entry.parts.filter(
    (part) =>
      (part.type === "text" && Boolean(part.text || part.content)) ||
      (part.type === "tool-call" && Boolean(part.toolCall)),
  );
  parts.push(...orderedParts);

  if (
    reply.content &&
    !orderedParts.some(
      (part) =>
        part.type === "text" &&
        (part.text || part.content)?.includes(reply.content),
    )
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

/** Called from the live MQTT handler when the turn ends. Pulls thinking,
 * text, and tool calls out of the in-memory streaming entry, attaches them
 * to the final reply as `parts_json`, and persists that blob to libsql. */
export async function persistStreamingPartsForReply(
  sessionId: string,
  actorId: string,
  reply: TeamclawMessage,
): Promise<void> {
  const turnId = reply.turnId;
  if (!turnId) return;
  const parts = buildCanonicalParts(sessionId, actorId, reply);
  if (parts.length === 0) return;

  const partsJson = JSON.stringify(parts);
  Object.assign(reply, { partsJson });
  try {
    await setMessageParts(reply.messageId, partsJson);
  } catch (e) {
    console.warn("[streaming-persist] parts_json write failed:", e);
  }
}
