import type { CurrentTeamMemberSummary, DirectoryBackend } from "../types";
import { toBackendError } from "../errors";

type ActorIdRow = {
  id: string;
  team_id?: string;
};

type DirectoryQuery = {
  select(columns: "id" | "id, team_id" | "id, display_name, team_role" | "joined_at"): DirectoryQuery;
  eq(column: string, value: string): DirectoryQuery;
  order(column: string, options?: { ascending?: boolean }): DirectoryQuery;
  limit(count: number): DirectoryQuery;
  maybeSingle(): Promise<{ data: ActorIdRow | null; error: unknown | null }>;
  then?: unknown;
};

export function createSupabaseDirectoryBackend(client: unknown): DirectoryBackend {
  const supabase = client as {
    from(table: string): DirectoryQuery;
  };

  return {
    async resolveCurrentMemberActor(teamId: string, userId: string) {
      const { data, error } = await supabase
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1)
        .maybeSingle();
      if (error) throw toBackendError(error, "directory.resolveCurrentMemberActor");
      return data ? { id: data.id } : null;
    },
    async resolveFirstMemberActorForUser(userId: string) {
      const { data, error } = await supabase
        .from("actors")
        .select("id, team_id")
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw toBackendError(error, "directory.resolveFirstMemberActorForUser");
      return data ? { id: data.id, team_id: data.team_id } : null;
    },
    async getCurrentTeamMember(teamId: string, userId: string): Promise<CurrentTeamMemberSummary | null> {
      const actorQuery = supabase
        .from("actor_directory")
        .select("id, display_name, team_role")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1) as unknown as Promise<{
        data: Array<{ id: string; display_name: string | null; team_role: string | null }> | null;
        error: unknown | null;
      }>;
      const { data: actorRows, error: actorError } = await actorQuery;
      if (actorError) throw toBackendError(actorError, "directory.getCurrentTeamMemberActor");
      const actor = actorRows?.[0];
      if (!actor) return null;

      const memberQuery = supabase
        .from("team_members")
        .select("joined_at")
        .eq("team_id", teamId)
        .eq("member_id", actor.id)
        .limit(1) as unknown as Promise<{
        data: Array<{ joined_at: string | null }> | null;
        error: unknown | null;
      }>;
      const { data: memberRows, error: memberError } = await memberQuery;

      return {
        id: actor.id,
        displayName: actor.display_name || "",
        role: actor.team_role,
        joinedAt: memberError ? null : memberRows?.[0]?.joined_at ?? null,
      };
    },
  };
}
