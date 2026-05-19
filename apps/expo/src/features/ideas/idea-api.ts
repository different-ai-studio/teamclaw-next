import type { Idea, IdeaStatus } from "./idea-types";

type SupabaseError = { message?: string } | null;
type QueryResult<T> = { data: T; error: SupabaseError };
type IdeasClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};

type IdeaRow = {
  id: string;
  team_id: string | null;
  workspace_id: string | null;
  created_by_actor_id: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  archived: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
};

function throwIfError(error: SupabaseError) {
  if (error?.message) throw new Error(error.message);
}

function toStatus(value: string | null): IdeaStatus {
  switch (value) {
    case "in_progress":
      return "in_progress";
    case "done":
      return "done";
    default:
      return "open";
  }
}

function toIdea(row: IdeaRow, workspaceName: string | null): Idea {
  return {
    ideaId: row.id,
    teamId: row.team_id ?? "",
    workspaceId: row.workspace_id ?? null,
    workspaceName,
    createdByActorId: row.created_by_actor_id ?? null,
    title: row.title?.trim() || "Untitled idea",
    description: row.description ?? "",
    status: toStatus(row.status),
    archived: Boolean(row.archived),
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? row.created_at ?? "",
  };
}

export function createIdeasApi(client: IdeasClient) {
  return {
    async listIdeas(teamId: string): Promise<Idea[]> {
      const ideaResult = (await client
        .from("ideas")
        .select(
          "id, team_id, workspace_id, created_by_actor_id, title, description, status, archived, created_at, updated_at",
        )
        .eq("team_id", teamId)
        .eq("archived", false)
        .order("updated_at", { ascending: false })) as QueryResult<IdeaRow[] | null>;
      throwIfError(ideaResult.error);

      const rows = ideaResult.data ?? [];
      if (rows.length === 0) return [];

      const workspaceIds = Array.from(
        new Set(rows.map((row) => row.workspace_id).filter((id): id is string => Boolean(id))),
      );

      let workspaceNames = new Map<string, string>();
      if (workspaceIds.length > 0) {
        const wsResult = (await client
          .from("workspaces")
          .select("id, name")
          .in("id", workspaceIds)) as QueryResult<WorkspaceRow[] | null>;
        throwIfError(wsResult.error);
        workspaceNames = new Map(
          (wsResult.data ?? []).map((row) => [row.id, row.name?.trim() ?? ""]),
        );
      }

      return rows.map((row) =>
        toIdea(row, row.workspace_id ? workspaceNames.get(row.workspace_id) ?? null : null),
      );
    },
  };
}
