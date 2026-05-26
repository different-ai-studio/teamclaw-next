import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type {
  ActorDirectorySyncRow,
  IdeaSyncRow,
  SessionParticipantSyncRow,
  SyncBackend,
} from "../types";

type QueryResult<T> = Promise<{ data: T; error: unknown | null }>;

type SupabaseSyncClient = {
  from(table: string): any;
};

const ACTOR_DIRECTORY_SYNC_COLUMNS =
  "id, team_id, actor_type, display_name, member_status, agent_status, last_active_at, created_at, updated_at";

const IDEA_SYNC_COLUMNS =
  "id, team_id, workspace_id, parent_idea_id, title, description, status, created_by_actor_id, archived, sort_order, created_at, updated_at";

const SESSION_PARTICIPANT_SYNC_COLUMNS =
  "id, session_id, actor_id, joined_at, created_at, updated_at";

async function readRows<T>(
  query: {
    gt(column: string, value: unknown): QueryResult<T[]>;
    then: QueryResult<T[]>["then"];
  },
  updatedAfter: string | null | undefined,
  operation: string,
): Promise<T[]> {
  const { data, error } = updatedAfter
    ? await query.gt("updated_at", updatedAfter)
    : await query;
  if (error) throw toBackendError(error, operation);
  return data ?? [];
}

export function createSupabaseSyncBackend(client: unknown = defaultSupabase): SyncBackend {
  const supabase = client as SupabaseSyncClient;

  return {
    async listActorDirectoryForSync(teamId, updatedAfter) {
      const query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_SYNC_COLUMNS)
        .eq("team_id", teamId) as {
        gt(column: string, value: unknown): QueryResult<ActorDirectorySyncRow[]>;
        then: QueryResult<ActorDirectorySyncRow[]>["then"];
      };
      return readRows(query, updatedAfter, "sync.listActorDirectoryForSync");
    },
    async listIdeasForSync(teamId, updatedAfter) {
      const query = supabase
        .from("ideas")
        .select(IDEA_SYNC_COLUMNS)
        .eq("team_id", teamId) as {
        gt(column: string, value: unknown): QueryResult<IdeaSyncRow[]>;
        then: QueryResult<IdeaSyncRow[]>["then"];
      };
      return readRows(query, updatedAfter, "sync.listIdeasForSync");
    },
    async listSessionParticipantsForSync(sessionId, updatedAfter) {
      const query = supabase
        .from("session_participants")
        .select(SESSION_PARTICIPANT_SYNC_COLUMNS)
        .eq("session_id", sessionId) as {
        gt(column: string, value: unknown): QueryResult<SessionParticipantSyncRow[]>;
        then: QueryResult<SessionParticipantSyncRow[]>["then"];
      };
      return readRows(query, updatedAfter, "sync.listSessionParticipantsForSync");
    },
  };
}
