import type { Actor, ActorType } from "./actor-types";

type SupabaseError = { message?: string } | null;

type QueryResult<T> = {
  data: T;
  error: SupabaseError;
};

type ActorsClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};

type ActorRow = {
  id: string;
  team_id: string | null;
  actor_type: string | null;
  display_name: string | null;
  last_active_at: string | null;
  avatar_url: string | null;
};

type MembershipRow = {
  member_id: string;
  role: string | null;
};

type AgentRow = {
  id: string;
  agent_types: string[] | null;
  default_agent_type: string | null;
};

function throwIfError(error: SupabaseError): void {
  if (error?.message) {
    throw new Error(error.message);
  }
}

function toActorType(value: string | null): ActorType {
  switch (value) {
    case "agent":
      return "agent";
    case "external":
      return "external";
    case "member":
    default:
      return "member";
  }
}

function toActor(
  row: ActorRow,
  role: string | null,
  agentTypes: string[],
  defaultAgentType: string | null,
): Actor {
  const agentKind = defaultAgentType ?? agentTypes[0] ?? null;
  return {
    actorId: row.id,
    teamId: row.team_id ?? "",
    actorType: toActorType(row.actor_type),
    displayName: row.display_name?.trim() || "Unnamed",
    role,
    lastActiveAt: row.last_active_at ?? null,
    avatarUrl: row.avatar_url ?? null,
    agentTypes,
    defaultAgentType,
    agentKind,
  };
}

export function createActorsApi(client: ActorsClient) {
  return {
    async listActors(teamId: string): Promise<Actor[]> {
      const actorResult = (await client
        .from("actors")
        .select("id, team_id, actor_type, display_name, last_active_at, avatar_url")
        .eq("team_id", teamId)
        .order("display_name", { ascending: true })) as QueryResult<ActorRow[] | null>;
      throwIfError(actorResult.error);

      const rows = actorResult.data ?? [];
      if (rows.length === 0) return [];

      const memberIds = rows
        .filter((row) => row.actor_type === "member")
        .map((row) => row.id);
      const agentIds = rows
        .filter((row) => row.actor_type === "agent")
        .map((row) => row.id);

      let rolesByMemberId = new Map<string, string>();
      if (memberIds.length > 0) {
        const membershipResult = (await client
          .from("team_members")
          .select("member_id, role")
          .eq("team_id", teamId)
          .in("member_id", memberIds)) as QueryResult<MembershipRow[] | null>;
        throwIfError(membershipResult.error);
        rolesByMemberId = new Map(
          (membershipResult.data ?? []).map((row) => [row.member_id, row.role ?? "member"]),
        );
      }

      let agentById = new Map<string, AgentRow>();
      if (agentIds.length > 0) {
        const agentResult = (await client
          .from("agents")
          .select("id, agent_types, default_agent_type")
          .in("id", agentIds)) as QueryResult<AgentRow[] | null>;
        if (!agentResult.error) {
          agentById = new Map((agentResult.data ?? []).map((row) => [row.id, row]));
        }
        // Agents are visibility-filtered (actor_directory hides personal
        // agents); errors are best-effort and shouldn't block the actor list.
      }

      return rows.map((row) =>
        toActor(
          row,
          rolesByMemberId.get(row.id) ?? null,
          agentById.get(row.id)?.agent_types ?? [],
          agentById.get(row.id)?.default_agent_type ?? null,
        ),
      );
    },
  };
}
