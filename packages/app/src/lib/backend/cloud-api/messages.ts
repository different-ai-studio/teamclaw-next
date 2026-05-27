import type { MessageHistoryRow, MessagesBackend, OutgoingMessageInput } from "../types";
import type { CloudApiClient } from "./http";

type CloudMessage = {
  id: string;
  teamId: string;
  sessionId: string;
  turnId: string | null;
  senderActorId: string | null;
  replyToMessageId: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  model: string | null;
  createdAt: string;
  updatedAt: string | null;
};

type Page<T> = { items: T[]; nextCursor: string | null };

function mapMessage(row: CloudMessage): MessageHistoryRow {
  return {
    id: row.id,
    team_id: row.teamId,
    session_id: row.sessionId,
    turn_id: row.turnId,
    sender_actor_id: row.senderActorId,
    reply_to_message_id: row.replyToMessageId,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata,
    model: row.model,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function createMessagesModule(client: CloudApiClient, delegate: MessagesBackend): MessagesBackend {
  return {
    ...delegate,
    async listMessages(sessionId: string): Promise<MessageHistoryRow[]> {
      const page = await client.get<Page<CloudMessage>>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      return page.items.map(mapMessage);
    },
    async insertOutgoingMessage(input: OutgoingMessageInput): Promise<MessageHistoryRow> {
      const message = await client.post<CloudMessage>(
        `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        {
          id: input.id,
          teamId: input.teamId,
          senderActorId: input.senderActorId,
          content: input.content,
          kind: input.kind,
          metadata: input.metadata,
          turnId: input.turnId,
          replyToMessageId: input.replyToMessageId,
          model: input.model,
          createdAt: input.createdAt,
        },
        { idempotencyKey: input.id },
      );
      return mapMessage(message);
    },
    async updateMessageContent(messageId: string, content: string): Promise<void> {
      await client.patch<CloudMessage>(`/v1/messages/${encodeURIComponent(messageId)}`, { content });
    },
  };
}
