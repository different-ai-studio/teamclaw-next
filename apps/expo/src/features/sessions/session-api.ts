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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args?: Record<string, unknown>) => any;
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
  attachments?: unknown[] | null;
};

type SessionMode = "solo" | "collab" | "control";

const SESSION_COLUMNS =
  "session_id:id, team_id, title, summary, last_message_preview, last_message_at, created_at, created_by:created_by_actor_id";
const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, attachments";

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
    async loadReadMarkers(
      sessionIds: string[],
      actorId: string,
    ): Promise<Map<string, string>> {
      if (sessionIds.length === 0 || !actorId) return new Map();
      const result = (await client
        .from("session_read_markers")
        .select("session_id, last_read_at")
        .in("session_id", sessionIds)
        .eq("actor_id", actorId)) as QueryResult<
        Array<{ session_id: string; last_read_at: string | null }> | null
      >;
      throwIfError(result.error);
      const map = new Map<string, string>();
      for (const row of result.data ?? []) {
        if (row.last_read_at) map.set(row.session_id, row.last_read_at);
      }
      return map;
    },

    async markSessionUnread(sessionId: string, actorId: string): Promise<void> {
      const result = (await client
        .from("session_read_markers")
        .delete()
        .eq("session_id", sessionId)
        .eq("actor_id", actorId)) as QueryResult<null>;
      throwIfError(result.error);
    },

    async removeParticipant(sessionId: string, actorId: string): Promise<void> {
      const result = (await client
        .from("session_participants")
        .delete()
        .eq("session_id", sessionId)
        .eq("actor_id", actorId)) as QueryResult<null>;
      throwIfError(result.error);
    },

    async addParticipants(
      sessionId: string,
      actorIds: ReadonlyArray<string>,
    ): Promise<void> {
      if (actorIds.length === 0) return;
      const rows = actorIds.map((actorId) => ({
        session_id: sessionId,
        actor_id: actorId,
      }));
      const result = (await client
        .from("session_participants")
        .upsert(rows, { onConflict: "session_id,actor_id" })) as QueryResult<null>;
      throwIfError(result.error);
    },

    async markSessionRead(
      sessionId: string,
      actorId: string,
      lastMessageId: string | null,
    ): Promise<void> {
      const result = (await client
        .from("session_read_markers")
        .upsert(
          {
            session_id: sessionId,
            actor_id: actorId,
            last_read_at: new Date().toISOString(),
            last_read_message_id: lastMessageId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "session_id,actor_id" },
        )) as QueryResult<null>;
      throwIfError(result.error);
    },

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

    async updateMessageContent(messageId: string, content: string): Promise<void> {
      const result = (await client
        .from("messages")
        .update({ content, updated_at: new Date().toISOString() })
        .eq("id", messageId)) as QueryResult<null>;
      throwIfError(result.error);
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

      if (input.attachments && input.attachments.length > 0) {
        payload.attachments = input.attachments;
      }

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

    async listSessions(teamId: string, currentActorId?: string): Promise<SessionSummary[]> {
      const result = await client
        .from("sessions")
        .select(SESSION_COLUMNS)
        .eq("team_id", teamId)
        .order("last_message_at", { ascending: false })
        .order("created_at", { ascending: false });
      throwIfError(result.error);

      const rows = (result.data ?? []) as SessionRecord[];
      const sessionIds = nonEmptySessionIds(rows.map((row) => row.session_id));
      const [participantMeta, readMarkers] = await Promise.all([
        loadParticipantMeta(client, sessionIds),
        currentActorId
          ? this.loadReadMarkers(sessionIds, currentActorId).catch(() => new Map())
          : Promise.resolve(new Map<string, string>()),
      ]);

      return rows.map((row) => {
        const summary = toSessionSummary(row, participantMeta[row.session_id ?? ""]);
        if (!currentActorId) return summary;
        const lastReadIso = readMarkers.get(summary.sessionId);
        if (!summary.lastMessageAt) return summary;
        if (!lastReadIso) return { ...summary, hasUnread: true };
        const lastMessageMs = Date.parse(summary.lastMessageAt);
        const lastReadMs = Date.parse(lastReadIso);
        if (Number.isNaN(lastMessageMs) || Number.isNaN(lastReadMs)) return summary;
        return { ...summary, hasUnread: lastMessageMs > lastReadMs + 500 };
      });
    },

    async createSession(input: {
      title: string;
      mode?: SessionMode;
      primaryAgentId?: string | null;
      ideaId?: string | null;
    }): Promise<string> {
      const result = (await client.rpc("create_session", {
        p_primary_agent_id: input.primaryAgentId ?? null,
        p_idea_id: input.ideaId ?? null,
        p_mode: input.mode ?? "collab",
        p_title: input.title,
      })) as QueryResult<string | null>;
      throwIfError(result.error);
      const sessionId = result.data;
      if (!sessionId || typeof sessionId !== "string") {
        throw new Error("create_session returned no session id");
      }
      return sessionId;
    },

    async updateRuntimeModel(runtimeId: string, model: string): Promise<void> {
      const result = (await client
        .from("agent_runtimes")
        .update({ current_model: model, updated_at: new Date().toISOString() })
        .eq("id", runtimeId)) as QueryResult<null>;
      throwIfError(result.error);
    },

    async loadRuntime(sessionId: string): Promise<
      | {
          runtimeId: string;
          status: string;
          currentModel: string | null;
          lastSeenAt: string | null;
          backendType: string | null;
        }
      | null
    > {
      const result = (await client
        .from("agent_runtimes")
        .select("id, status, current_model, last_seen_at, backend_type")
        .eq("session_id", sessionId)
        .maybeSingle()) as {
        data:
          | {
              id: string;
              status: string | null;
              current_model: string | null;
              last_seen_at: string | null;
              backend_type: string | null;
            }
          | null;
        error: SupabaseError;
      };
      throwIfError(result.error);
      if (!result.data) return null;
      return {
        runtimeId: result.data.id,
        status: result.data.status ?? "unknown",
        currentModel: result.data.current_model ?? null,
        lastSeenAt: result.data.last_seen_at ?? null,
        backendType: result.data.backend_type ?? null,
      };
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
