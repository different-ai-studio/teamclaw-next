import {
  mapMessageRecord,
  mapSessionRecord,
  type MessageRecord,
  type SessionMessage,
  type SessionRecord,
  type SessionSummary,
} from "./session-types";

type SupabaseError = { message?: string } | null;

type SessionsClient = {
  from: (table: string) => any;
};

type ParticipantRow = {
  session_id: string;
  actor_id: string | null;
};

type ParticipantMeta = {
  count: number;
  actorIds: string[];
};

type QueryResult<T> = {
  data: T;
  error: SupabaseError;
};

type OutgoingMessageInput = {
  id: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  content: string;
  createdAt?: string;
  metadata?: unknown | null;
  model?: string | null;
  turnId?: string | null;
  replyToMessageId?: string | null;
};

const SESSION_COLUMNS =
  "session_id:id, team_id, title, summary, last_message_preview, last_message_at, created_at, created_by:created_by_actor_id";
const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at";

function throwIfError(error: SupabaseError): void {
  if (error) {
    throw new Error(error.message ?? "Supabase request failed");
  }
}

async function loadParticipantMeta(
  client: SessionsClient,
  sessionIds: string[],
): Promise<Record<string, ParticipantMeta>> {
  if (sessionIds.length === 0) {
    return {};
  }

  const result = (await client
    .from("session_participants")
    .select("session_id, actor_id")
    .order("actor_id", { ascending: true })
    .in("session_id", sessionIds)) as QueryResult<ParticipantRow[] | null>;
  throwIfError(result.error);

  return (result.data ?? []).reduce<Record<string, ParticipantMeta>>((metaBySessionId, row) => {
    const sessionMeta = metaBySessionId[row.session_id] ?? { count: 0, actorIds: [] };
    sessionMeta.count += 1;

    if (row.actor_id && !sessionMeta.actorIds.includes(row.actor_id)) {
      sessionMeta.actorIds.push(row.actor_id);
    }

    metaBySessionId[row.session_id] = sessionMeta;
    return metaBySessionId;
  }, {});
}

function nonEmptySessionIds(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function normalizeTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareMessageRecords(left: MessageRecord, right: MessageRecord): number {
  const createdAtDiff = normalizeTimestamp(left.created_at) - normalizeTimestamp(right.created_at);

  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return (left.id ?? "").localeCompare(right.id ?? "");
}

function toSessionSummary(
  record: SessionRecord,
  participantMeta: ParticipantMeta = { count: 0, actorIds: [] },
): SessionSummary {
  const summary = mapSessionRecord({
    ...record,
    participant_count: participantMeta.count,
  });

  return {
    ...summary,
    participantActorIds: participantMeta.actorIds,
  };
}

export function createSessionsApi(client: SessionsClient) {
  return {
    async resolveMemberActorId(teamId: string, userId: string): Promise<string | null> {
      const result = (await client
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1)
        .maybeSingle()) as QueryResult<{ id: string } | null>;
      throwIfError(result.error);

      return result.data?.id ?? null;
    },

    async insertOutgoingMessage(input: OutgoingMessageInput): Promise<void> {
      const payload: Record<string, unknown> = {
        id: input.id,
        team_id: input.teamId,
        session_id: input.sessionId,
        sender_actor_id: input.senderActorId,
        kind: "text",
        content: input.content,
        metadata: input.metadata ?? null,
        model: input.model ?? null,
        turn_id: input.turnId ?? null,
        reply_to_message_id: input.replyToMessageId ?? null,
      };

      if (input.createdAt) {
        payload.created_at = input.createdAt;
      }

      const result = (await client.from("messages").insert(payload)) as QueryResult<null>;
      throwIfError(result.error);
    },

    async listMessages(teamId: string, sessionId: string): Promise<SessionMessage[]> {
      const result = (await client
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("team_id", teamId)
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })) as QueryResult<MessageRecord[] | null>;
      throwIfError(result.error);

      return [...(result.data ?? [])].sort(compareMessageRecords).map((row) => mapMessageRecord(row));
    },

    async listSessions(teamId: string): Promise<SessionSummary[]> {
      const result = await client
        .from("sessions")
        .select(SESSION_COLUMNS)
        .eq("team_id", teamId)
        .order("last_message_at", { ascending: false })
        .order("created_at", { ascending: false });
      throwIfError(result.error);

      const rows = (result.data ?? []) as SessionRecord[];
      const participantMeta = await loadParticipantMeta(
        client,
        nonEmptySessionIds(rows.map((row) => row.session_id)),
      );

      return rows.map((row) => toSessionSummary(row, participantMeta[row.session_id ?? ""]));
    },

    async getSession(teamId: string, sessionId: string): Promise<SessionSummary | null> {
      const result = await client
        .from("sessions")
        .select(SESSION_COLUMNS)
        .eq("team_id", teamId)
        .eq("id", sessionId)
        .maybeSingle();
      throwIfError(result.error);

      if (!result.data) {
        return null;
      }

      const participantMeta = await loadParticipantMeta(
        client,
        nonEmptySessionIds([result.data.session_id]),
      );

      return toSessionSummary(result.data, participantMeta[result.data.session_id ?? ""]);
    },
  };
}
