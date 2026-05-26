import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type {
  SessionCreateInput,
  SessionListCursor,
  SessionListEntry,
  SessionParticipant,
  SessionSyncRow,
  SessionsBackend,
} from "../types";

type SupabaseSessionsClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown | null }>;
  from(table: string): {
    insert(rows: unknown): Promise<{ error: unknown | null }>;
    upsert(
      rows: unknown,
      options?: { onConflict?: string },
    ): Promise<{ error: unknown | null }>;
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): Promise<{ error: unknown | null }>;
    };
    select(columns: string): {
      eq(column: string, value: unknown): unknown;
    };
  };
};

type SupabaseSessionRow = {
  id: string;
  title?: string | null;
  team_id: string;
  last_message_at?: string | null;
  last_message_preview?: string | null;
  mode?: string | null;
  idea_id?: string | null;
  has_unread?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

const SESSION_SYNC_COLUMNS =
  "id, team_id, title, mode, primary_agent_id, idea_id, summary, last_message_preview, last_message_at, created_by_actor_id, created_at, updated_at";

function mapSessionRow(row: SupabaseSessionRow): SessionListEntry {
  return {
    id: row.id,
    title: row.title ?? "",
    team_id: row.team_id,
    last_message_at: row.last_message_at ?? null,
    last_message_preview: row.last_message_preview ?? null,
    mode: (row.mode as SessionListEntry["mode"] | null) ?? "solo",
    idea_id: row.idea_id ?? null,
    has_unread: row.has_unread === true,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function uniqueActorIds(actorIds: string[]): string[] {
  return Array.from(new Set(actorIds));
}

function assertSupabaseClient(client: SupabaseSessionsClient): void {
  if (typeof client.rpc !== "function" || typeof client.from !== "function") {
    throw new Error("sessions backend not implemented");
  }
}

export function createSupabaseSessionsBackend(client: unknown = defaultSupabase): SessionsBackend {
  const supabase = client as SupabaseSessionsClient;

  return {
    async listCurrentActorSessions(args: { limit: number; cursor: SessionListCursor | null }) {
      assertSupabaseClient(supabase);
      const { limit, cursor } = args;
      const { data, error } = await supabase.rpc("list_current_actor_sessions", {
        p_limit: limit,
        p_before_last_message_at: cursor?.lastMessageAt ?? null,
        p_before_created_at: cursor?.createdAt ?? null,
        p_before_id: cursor?.id ?? null,
      });
      if (error) throw toBackendError(error, "sessions.listCurrentActorSessions");
      return { rows: ((data ?? []) as SupabaseSessionRow[]).map(mapSessionRow) };
    },
    async markCurrentActorSessionViewed(sessionId: string, lastReadMessageId?: string | null) {
      assertSupabaseClient(supabase);
      const { error } = await supabase.rpc("mark_current_actor_session_viewed", {
        p_session_id: sessionId,
        p_last_read_message_id: lastReadMessageId ?? null,
      });
      if (error) throw toBackendError(error, "sessions.markCurrentActorSessionViewed");
    },
    async createSessionShell(input: SessionCreateInput) {
      assertSupabaseClient(supabase);
      const { error: sessionError } = await supabase.from("sessions").insert({
        id: input.id,
        team_id: input.teamId,
        created_by_actor_id: input.createdByActorId,
        mode: "collab",
        title: input.title,
        idea_id: input.ideaId ?? null,
      });
      if (sessionError) throw toBackendError(sessionError, "sessions.createSessionShell");

      const participantRows = uniqueActorIds([
        input.createdByActorId,
        ...input.additionalActorIds,
      ]).map((actorId) => ({
        session_id: input.id,
        actor_id: actorId,
      }));

      if (participantRows.length > 0) {
        const { error: participantsError } = await supabase
          .from("session_participants")
          .insert(participantRows);
        if (participantsError) {
          throw toBackendError(participantsError, "sessions.createSessionShellParticipants");
        }
      }

      return { sessionId: input.id };
    },
    async addParticipants(sessionId: string, actorIds: string[]) {
      assertSupabaseClient(supabase);
      const rows = uniqueActorIds(actorIds).map((actorId) => ({
        session_id: sessionId,
        actor_id: actorId,
      }));
      if (rows.length === 0) return;
      const { error } = await supabase
        .from("session_participants")
        .upsert(rows, { onConflict: "session_id,actor_id" });
      if (error) throw toBackendError(error, "sessions.addParticipants");
    },
    async updateSessionTitle(sessionId: string, title: string) {
      assertSupabaseClient(supabase);
      const { error } = await supabase.from("sessions").update({ title }).eq("id", sessionId);
      if (error) throw toBackendError(error, "sessions.updateSessionTitle");
    },
    async archiveSession(sessionId: string, archivedAt: string) {
      assertSupabaseClient(supabase);
      const { error } = await supabase
        .from("sessions")
        .update({ archived_at: archivedAt })
        .eq("id", sessionId);
      if (error) throw toBackendError(error, "sessions.archiveSession");
    },
    async getSessionParticipants(sessionId: string) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("session_participants")
        .select("session_id, actor_id, role")
        .eq("session_id", sessionId) as QueryResult<SessionParticipant[]>;
      const { data, error } = await query;
      if (error) throw toBackendError(error, "sessions.getSessionParticipants");
      return data ?? [];
    },
    async getSessionTeamId(sessionId: string) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("sessions")
        .select("team_id")
        .eq("id", sessionId) as {
        maybeSingle(): QueryResult<{ team_id?: string | null } | null>;
      };
      const { data, error } = await query.maybeSingle();
      if (error) throw toBackendError(error, "sessions.getSessionTeamId");
      return data?.team_id ?? null;
    },
    async listSessionsForTeamSince(teamId: string, updatedAfter: string) {
      assertSupabaseClient(supabase);
      const baseQuery = supabase
        .from("sessions")
        .select(SESSION_SYNC_COLUMNS)
        .eq("team_id", teamId) as {
        gt(column: string, value: unknown): QueryResult<SessionSyncRow[]>;
        then: QueryResult<SessionSyncRow[]>["then"];
      };
      const { data, error } = updatedAfter
        ? await baseQuery.gt("updated_at", updatedAfter)
        : await baseQuery;
      if (error) throw toBackendError(error, "sessions.listSessionsForTeamSince");
      return data ?? [];
    },
  };
}
