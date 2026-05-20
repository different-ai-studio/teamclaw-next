// Synthesize proto Message rows from the in-memory streaming entry on
// agent-reply finalize. The daemon only persists AGENT_REPLY to Supabase
// (thinking / tool_call / tool_result are intentionally ephemeral), so
// without this step the parts vanish on reload. Each synthetic row shares
// the AGENT_REPLY's turn_id, so `v2-message-adapter.groupByTurn` reassembles
// them into a single unified bubble.

import { create as createMessage } from "@bufbuild/protobuf";
import {
  MessageSchema,
  MessageKind,
  type Message as TeamclawMessage,
} from "@/lib/proto/teamclaw_pb";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionListStore } from "@/stores/session-list-store";
import { upsertMessagesBatch, type MessageRow } from "@/lib/local-cache";

function kindString(kind: MessageKind): string {
  switch (kind) {
    case MessageKind.AGENT_THINKING:
      return "agent_thinking";
    case MessageKind.AGENT_TOOL_CALL:
      return "agent_tool_call";
    case MessageKind.AGENT_TOOL_RESULT:
      return "agent_tool_result";
    case MessageKind.AGENT_REPLY:
      return "agent_reply";
    case MessageKind.SYSTEM:
      return "system";
    case MessageKind.TEXT:
    default:
      return "text";
  }
}

function protoToRow(
  proto: TeamclawMessage,
  teamId: string,
  metadataJson: string | null,
): MessageRow {
  const now = new Date().toISOString();
  return {
    id: proto.messageId,
    teamId,
    sessionId: proto.sessionId,
    turnId: proto.turnId || null,
    senderActorId: proto.senderActorId || null,
    replyToMessageId: null,
    kind: kindString(proto.kind),
    content: proto.content,
    metadataJson,
    model: proto.model || null,
    mentionsJson: null,
    origin: "local-only",
    createdAt: new Date(Number(proto.createdAt) * 1000).toISOString(),
    updatedAt: now,
    deletedAt: null,
    syncedAt: now,
    partsJson: null,
  };
}

interface Synth {
  proto: TeamclawMessage;
  metadataJson: string | null;
}

/** Build synthetic proto Messages for the streaming entry's thinking and
 * tool calls. All share `turnId` and `senderActorId`. `replyCreatedAt`
 * (UNIX seconds) anchors createdAt so the rows sort before the agent reply.
 *
 * Idempotent: messageId is derived deterministically from turn_id + kind +
 * tool id, so calling twice produces the same rows (libsql upsert is a
 * no-op on equal updated_at, store.appendMessage dedups by messageId). */
function synthesize(
  sessionId: string,
  actorId: string,
  turnId: string,
  replyCreatedAt: bigint,
): Synth[] {
  const entry = useV2StreamingStore.getState().byKey[`${sessionId}::${actorId}`];
  if (!entry) return [];
  const out: Synth[] = [];

  // Anchor synthesized rows slightly *before* the reply so they sort first
  // in adapter group order. Use 1-second offsets per part — coarse but the
  // adapter groups by (turnId, senderId) so intra-turn ordering only needs
  // to be stable enough for thinking/tools to land before the reply.
  let createdAt = replyCreatedAt - BigInt(entry.toolCalls.length + 1);

  if (entry.thinkingText.length > 0) {
    out.push({
      proto: createMessage(MessageSchema, {
        messageId: `synth:${turnId}:thinking`,
        sessionId,
        senderActorId: actorId,
        kind: MessageKind.AGENT_THINKING,
        content: entry.thinkingText,
        turnId,
        createdAt,
      }),
      metadataJson: null,
    });
    createdAt += BigInt(1);
  }

  for (const tc of entry.toolCalls) {
    const callMeta = {
      tool_id: tc.id,
      tool_name: tc.name,
      description:
        typeof tc.arguments?._description === "string"
          ? tc.arguments._description
          : "",
    };
    out.push({
      proto: createMessage(MessageSchema, {
        messageId: `synth:${turnId}:call:${tc.id}`,
        sessionId,
        senderActorId: actorId,
        kind: MessageKind.AGENT_TOOL_CALL,
        content: tc.name,
        turnId,
        createdAt,
      }),
      metadataJson: JSON.stringify(callMeta),
    });
    createdAt += BigInt(1);

    if (tc.status === "completed" || tc.status === "failed") {
      const resultMeta = {
        tool_id: tc.id,
        success: tc.status === "completed",
      };
      out.push({
        proto: createMessage(MessageSchema, {
          messageId: `synth:${turnId}:result:${tc.id}`,
          sessionId,
          senderActorId: actorId,
          kind: MessageKind.AGENT_TOOL_RESULT,
          content: typeof tc.result === "string" ? tc.result : "",
          turnId,
          createdAt,
        }),
        metadataJson: JSON.stringify(resultMeta),
      });
    }
  }

  return out;
}

/** Called from the live MQTT handler when an AGENT_REPLY arrives. Pulls
 * thinking + tool_calls out of the in-memory streaming entry, synthesizes
 * proto Messages with the reply's turn_id, appends them to the session
 * store (idempotent by messageId), and persists to libsql so reload
 * restores the full conversation. */
export async function persistStreamingPartsForReply(
  sessionId: string,
  actorId: string,
  reply: TeamclawMessage,
): Promise<void> {
  const turnId = reply.turnId;
  if (!turnId) return;
  const synths = synthesize(sessionId, actorId, turnId, reply.createdAt);
  if (synths.length === 0) return;

  const store = useSessionMessageStore.getState();
  for (const s of synths) {
    store.appendMessage(sessionId, s.proto);
  }

  const teamId =
    useSessionListStore.getState().rows.find((r) => r.id === sessionId)
      ?.team_id ?? "";
  try {
    await upsertMessagesBatch(
      synths.map((s) => protoToRow(s.proto, teamId, s.metadataJson)),
    );
  } catch (e) {
    console.warn("[streaming-persist] libsql write failed:", e);
  }
}
