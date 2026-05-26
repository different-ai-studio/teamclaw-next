import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type {
  ActorDirectoryEntry,
  SessionMemberCandidate,
  SessionMembersBackend,
} from "../types";

type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseSessionMembersClient = {
  from(table: string): {
    delete(): {
      eq(column: string, value: unknown): unknown;
    };
    upsert(
      row: Record<string, unknown>,
      options?: { onConflict?: string; ignoreDuplicates?: boolean },
    ): Promise<{ error: unknown | null }>;
    select(columns: string): unknown;
  };
};

const ACTOR_DIRECTORY_COLUMNS =
  "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at";

function assertSupabaseClient(client: SupabaseSessionMembersClient): void {
  if (typeof client.from !== "function") {
    throw new Error("sessionMembers backend not implemented");
  }
}

function normalizeActor(row: ActorDirectoryEntry): ActorDirectoryEntry {
  return {
    ...row,
    display_name: row.display_name ?? null,
    actor_type: row.actor_type ?? null,
    member_status: row.member_status ?? null,
    agent_status: row.agent_status ?? null,
    agent_types: Array.isArray(row.agent_types) ? row.agent_types : null,
    default_agent_type: row.default_agent_type ?? null,
    last_active_at: row.last_active_at ?? null,
  };
}

function visibleSessionActor(row: ActorDirectoryEntry): boolean {
  return row.actor_type === "member" || row.actor_type === "agent";
}

export function createSupabaseSessionMembersBackend(client: unknown = defaultSupabase): SessionMembersBackend {
  const supabase = client as SupabaseSessionMembersClient;

  return {
    async listParticipants(sessionId: string) {
      assertSupabaseClient(supabase);
      const participantQuery = supabase
        .from("session_participants")
        .select("actor_id") as {
        eq(column: string, value: unknown): QueryResult<Array<{ actor_id: string }>>;
      };
      const { data: participants, error: participantError } = await participantQuery.eq("session_id", sessionId);
      if (participantError) throw toBackendError(participantError, "sessionMembers.listParticipants");

      const actorIds = (participants ?? []).map((row) => row.actor_id).filter(Boolean);
      if (actorIds.length === 0) return [];

      const actorQuery = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS) as {
        in(column: string, values: string[]): QueryResult<ActorDirectoryEntry[]>;
      };
      const { data: actors, error: actorsError } = await actorQuery.in("id", actorIds);
      if (actorsError) throw toBackendError(actorsError, "sessionMembers.listParticipantsActors");

      const byId = new Map((actors ?? []).map((row) => [row.id, normalizeActor(row)] as const));
      return actorIds
        .map((actorId) => byId.get(actorId))
        .filter((row): row is ActorDirectoryEntry => !!row);
    },
    async listSessionIdsForActor(actorId: string) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("session_participants")
        .select("session_id") as {
        eq(column: string, value: unknown): QueryResult<Array<{ session_id: string }>>;
      };
      const { data, error } = await query.eq("actor_id", actorId);
      if (error) throw toBackendError(error, "sessionMembers.listSessionIdsForActor");
      return (data ?? []).map((row) => row.session_id).filter(Boolean);
    },
    async listCandidateActors(teamId: string, presentActorIds: string[]) {
      assertSupabaseClient(supabase);
      const present = new Set(presentActorIds);
      const query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS) as {
        eq(column: string, value: unknown): QueryResult<ActorDirectoryEntry[]>;
      };
      const { data, error } = await query.eq("team_id", teamId);
      if (error) throw toBackendError(error, "sessionMembers.listCandidateActors");

      return (data ?? [])
        .filter(visibleSessionActor)
        .map((row): SessionMemberCandidate => ({
          ...normalizeActor(row),
          is_present: present.has(row.id),
        }))
        .filter((row) => !row.is_present);
    },
    async addParticipant(sessionId: string, actorId: string) {
      assertSupabaseClient(supabase);
      const { error } = await supabase
        .from("session_participants")
        .upsert(
          { session_id: sessionId, actor_id: actorId },
          { onConflict: "session_id,actor_id", ignoreDuplicates: true },
        );
      if (error) throw toBackendError(error, "sessionMembers.addParticipant");
    },
    async removeParticipant(sessionId: string, actorId: string) {
      assertSupabaseClient(supabase);
      const query = supabase
        .from("session_participants")
        .delete()
        .eq("session_id", sessionId) as {
        eq(column: string, value: unknown): Promise<{ error: unknown | null }>;
      };
      const { error } = await query.eq("actor_id", actorId);
      if (error) throw toBackendError(error, "sessionMembers.removeParticipant");
    },
  };
}
