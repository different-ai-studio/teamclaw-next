import { supabase } from "@/lib/supabase-client";

export interface CurrentActorHint {
  currentTeamId?: string | null;
  currentMemberId?: string | null;
}

export async function resolveCurrentMemberActorId(
  teamId: string,
  userId: string,
  hint: CurrentActorHint = {},
): Promise<string | null> {
  if (hint.currentTeamId === teamId && hint.currentMemberId) {
    return hint.currentMemberId;
  }

  const { data: directoryRows, error: directoryError } = await supabase
    .from("actor_directory")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("actor_type", "member")
    .limit(1);

  if (!directoryError && directoryRows?.[0]?.id) {
    return directoryRows[0].id as string;
  }

  const { data: actorRows, error: actorError } = await supabase
    .from("actors")
    .select("id, team_id")
    .eq("user_id", userId);

  if (actorError) throw actorError;

  const match = (actorRows ?? []).find((row) => row.team_id === teamId);
  return (match?.id as string | undefined) ?? null;
}
