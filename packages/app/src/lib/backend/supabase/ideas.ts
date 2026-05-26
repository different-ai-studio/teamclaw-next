import { toBackendError } from "../errors";
import type {
  IdeaActivityRow,
  IdeaActorSummary,
  IdeaDetailRow,
  IdeaFullUpdateInput,
  IdeaRow,
  IdeaSortOrderUpdateInput,
  IdeasBackend,
} from "../types";
import { supabase as defaultSupabase } from "./client";

type SupabaseResult<T> = Promise<{ data: T | null; error: unknown | null }>;

type SupabaseIdeasClient = {
  rpc(name: string, args: Record<string, unknown>): SupabaseResult<unknown>;
  from(table: string): {
    select(columns: string): unknown;
    update(payload: Record<string, unknown>): {
      eq(column: string, value: unknown): SupabaseResult<unknown>;
    };
  };
};

type EqChain<T> = {
  eq(column: string, value: unknown): EqChain<T> & SupabaseResult<T>;
  in(column: string, values: unknown[]): SupabaseResult<T>;
  limit(count: number): {
    maybeSingle(): SupabaseResult<T extends Array<infer Row> ? Row : T>;
  };
  maybeSingle(): SupabaseResult<T extends Array<infer Row> ? Row : T>;
  single(): SupabaseResult<T extends Array<infer Row> ? Row : T>;
  order(column: string, options?: { ascending?: boolean }): EqChain<T> & SupabaseResult<T>;
};

const IDEA_LIST_COLUMNS = "id, title, status, created_by_actor_id, sort_order, updated_at";
const IDEA_DETAIL_COLUMNS = "id, team_id, workspace_id, title, description, status, created_by_actor_id, created_at, updated_at";
const IDEA_ACTIVITY_COLUMNS = "id, actor_id, activity_type, content, created_at";
const IDEA_ACTOR_COLUMNS = "id, display_name, actor_type";

function selectQuery<T>(supabase: SupabaseIdeasClient, table: string, columns: string): EqChain<T> {
  return supabase.from(table).select(columns) as EqChain<T>;
}

function ideaBody(input: { body?: string | null; description?: string | null }): string | null {
  return input.description ?? input.body ?? null;
}

function backendDataError(operation: string, message: string): never {
  throw toBackendError({ message }, operation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCreateIdeaRow(data: unknown): IdeaRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (
    !isRecord(row)
    || typeof row.id !== "string"
    || typeof row.team_id !== "string"
    || typeof row.title !== "string"
  ) {
    backendDataError("ideas.createIdea", "ideas.createIdea returned malformed idea row");
  }
  return row as unknown as IdeaRow;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSortOrderUpdate(input: IdeaSortOrderUpdateInput | IdeaFullUpdateInput): input is IdeaSortOrderUpdateInput {
  return hasOwn(input as unknown as Record<string, unknown>, "sortOrder");
}

function validateSortOrderUpdate(input: IdeaSortOrderUpdateInput | IdeaFullUpdateInput): IdeaSortOrderUpdateInput {
  if (
    input.title !== undefined
    || input.body !== undefined
    || input.description !== undefined
    || input.status !== undefined
    || input.workspaceId !== undefined
  ) {
    backendDataError(
      "ideas.updateIdea",
      "ideas.updateIdea requires either sortOrder only or title, status, and workspaceId",
    );
  }
  return input;
}

function validateFullUpdate(input: IdeaSortOrderUpdateInput | IdeaFullUpdateInput): IdeaFullUpdateInput {
  const record = input as unknown as Record<string, unknown>;
  if (
    !hasOwn(record, "title")
    || !hasOwn(record, "status")
    || !hasOwn(record, "workspaceId")
  ) {
    backendDataError(
      "ideas.updateIdea",
      "ideas.updateIdea requires either sortOrder only or title, status, and workspaceId",
    );
  }
  return input as IdeaFullUpdateInput;
}

export function createSupabaseIdeasBackend(client: unknown = defaultSupabase): IdeasBackend {
  const supabase = client as SupabaseIdeasClient;

  return {
    async listIdeas(teamId) {
      const { data, error } = await selectQuery<IdeaRow[]>(supabase, "ideas", IDEA_LIST_COLUMNS)
        .eq("team_id", teamId)
        .eq("archived", false)
        .order("sort_order", { ascending: true })
        .order("updated_at", { ascending: false });
      if (error) throw toBackendError(error, "ideas.listIdeas");
      return data ?? [];
    },
    async getIdeaDetail(ideaId) {
      const { data: ideaData, error: ideaError } = await selectQuery<IdeaDetailRow[]>(supabase, "ideas", IDEA_DETAIL_COLUMNS)
        .eq("id", ideaId)
        .maybeSingle();
      if (ideaError) throw toBackendError(ideaError, "ideas.getIdeaDetail");
      if (!ideaData) return null;

      const { data: activityData, error: activityError } = await selectQuery<IdeaActivityRow[]>(
        supabase,
        "idea_activities",
        IDEA_ACTIVITY_COLUMNS,
      )
        .eq("idea_id", ideaId)
        .order("created_at", { ascending: false });
      if (activityError) throw toBackendError(activityError, "ideas.getIdeaDetail.activities");

      const activities = activityData ?? [];
      const actorIds = Array.from(new Set([
        ideaData.created_by_actor_id,
        ...activities.map((activity) => activity.actor_id),
      ].filter((id): id is string => typeof id === "string" && id.length > 0)));

      let actors: IdeaActorSummary[] = [];
      if (actorIds.length > 0) {
        const { data: actorData, error: actorError } = await selectQuery<IdeaActorSummary[]>(supabase, "actors", IDEA_ACTOR_COLUMNS)
          .in("id", actorIds);
        if (actorError) throw toBackendError(actorError, "ideas.getIdeaDetail.actors");
        actors = actorData ?? [];
      }

      return {
        ...ideaData,
        activities,
        actors,
      };
    },
    async createIdea(input) {
      const { data, error } = await supabase.rpc("create_idea", {
        p_team_id: input.teamId,
        p_title: input.title,
        p_workspace_id: input.workspaceId ?? null,
        p_description: ideaBody(input),
      });
      if (error) throw toBackendError(error, "ideas.createIdea");
      return validateCreateIdeaRow(data);
    },
    async updateIdea(input) {
      if (isSortOrderUpdate(input)) {
        const sortUpdate = validateSortOrderUpdate(input);
        const { error } = await supabase
          .from("ideas")
          .update({ sort_order: sortUpdate.sortOrder })
          .eq("id", sortUpdate.ideaId);
        if (error) throw toBackendError(error, "ideas.updateIdea.sortOrder");
        return;
      }

      const fullUpdate = validateFullUpdate(input);
      const { error } = await supabase.rpc("update_idea", {
        p_idea_id: fullUpdate.ideaId,
        p_workspace_id: fullUpdate.workspaceId,
        p_title: fullUpdate.title,
        p_description: ideaBody(fullUpdate),
        p_status: fullUpdate.status,
      });
      if (error) throw toBackendError(error, "ideas.updateIdea");
    },
    async archiveIdea(ideaId) {
      const { error } = await supabase.rpc("archive_idea", {
        p_idea_id: ideaId,
        p_archived: true,
      });
      if (error) throw toBackendError(error, "ideas.archiveIdea");
    },
    async createIdeaActivity(input) {
      const { error } = await supabase.rpc("create_idea_activity", {
        p_idea_id: input.ideaId,
        p_activity_type: input.activityType ?? input.eventType,
        p_content: input.content ?? null,
        p_metadata: input.metadata ?? {},
      });
      if (error) throw toBackendError(error, "ideas.createIdeaActivity");
    },
  };
}
