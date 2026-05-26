import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type {
  MessageHistoryRow,
  MessageSyncRow,
  MessagesBackend,
  OutgoingMessageInput,
} from "../types";

const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at, attachments";
const MESSAGE_SYNC_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";

type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseMessagesClient = {
  from(table: string): {
    insert(row: Record<string, unknown>): {
      select(columns: string): {
        single(): QueryResult<MessageHistoryRow>;
      };
    };
    select(columns: string): {
      eq(column: string, value: unknown): unknown;
    };
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): Promise<{ error: unknown | null }>;
    };
  };
};

function assertSupabaseClient(client: SupabaseMessagesClient): void {
  if (typeof client.from !== "function") {
    throw new Error("messages backend not implemented");
  }
}

function outgoingMessageRow(input: OutgoingMessageInput): Record<string, unknown> {
  const row: Record<string, unknown> = {
    ...(input.id ? { id: input.id } : {}),
    team_id: input.teamId,
    session_id: input.sessionId,
    sender_actor_id: input.senderActorId,
    kind: input.kind ?? "text",
    content: input.content,
    metadata: input.metadata ?? null,
    model: input.model ?? null,
    turn_id: input.turnId ?? null,
    reply_to_message_id: input.replyToMessageId ?? null,
  };
  if (input.attachments && input.attachments.length > 0) {
    row.attachments = input.attachments;
  }
  if (input.createdAt) {
    row.created_at = input.createdAt;
  }
  return row;
}

export function createSupabaseMessagesBackend(client: unknown = defaultSupabase): MessagesBackend {
  const supabase = client as SupabaseMessagesClient;

  return {
    async insertOutgoingMessage(input: OutgoingMessageInput) {
      assertSupabaseClient(supabase);
      const { data, error } = await supabase
        .from("messages")
        .insert(outgoingMessageRow(input))
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) throw toBackendError(error, "messages.insertOutgoingMessage");
      return data;
    },
    async listMessages(sessionId: string) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId) as {
        order(
          column: string,
          options: { ascending: boolean },
        ): { order(column: string, options: { ascending: boolean }): QueryResult<MessageHistoryRow[]> };
      };
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw toBackendError(error, "messages.listMessages");
      return data ?? [];
    },
    async updateMessageContent(messageId: string, content: string) {
      assertSupabaseClient(supabase);
      const { error } = await supabase
        .from("messages")
        .update({ content, updated_at: new Date().toISOString() })
        .eq("id", messageId);
      if (error) throw toBackendError(error, "messages.updateMessageContent");
    },
    async listMessagesForSessionSince(sessionId: string, updatedAfter?: string | null) {
      assertSupabaseClient(supabase);
      const baseQuery = supabase
        .from("messages")
        .select(MESSAGE_SYNC_COLUMNS)
        .eq("session_id", sessionId) as {
        gt(column: string, value: unknown): QueryResult<MessageSyncRow[]>;
        then: QueryResult<MessageSyncRow[]>["then"];
      };
      const { data, error } = updatedAfter
        ? await baseQuery.gt("updated_at", updatedAfter)
        : await baseQuery;
      if (error) throw toBackendError(error, "messages.listMessagesForSessionSince");
      return data ?? [];
    },
  };
}
