import type { DirectoryBackend } from "../types";
import { toBackendError } from "../errors";

type ActorIdRow = {
  id: string;
};

export function createSupabaseDirectoryBackend(client: unknown): DirectoryBackend {
  const supabase = client as {
    from(table: "actors"): {
      select(columns: "id"): {
        eq(column: string, value: string): {
          eq(column: string, value: string): {
            eq(column: string, value: string): {
              limit(count: number): {
                maybeSingle(): Promise<{ data: ActorIdRow | null; error: unknown | null }>;
              };
            };
          };
        };
      };
    };
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
  };
}
