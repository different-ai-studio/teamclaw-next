import type { Actor, ActorType } from "./actor-types";

type SupabaseError = { message?: string } | null;

type QueryResult<T> = {
  data: T;
  error: SupabaseError;
};

type ActorsClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
  rpc?: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: SupabaseError }>;
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
  default_workspace_id: string | null;
  owner_member_id: string | null;
  visibility: string | null;
  device_id: string | null;
};

export type ActorInviteResult = {
  token: string;
  deeplink: string;
  expiresAt: string;
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
  defaultWorkspaceId: string | null,
  ownerMemberId: string | null,
  visibility: string | null,
  deviceId: string | null,
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
    defaultWorkspaceId,
    ownerMemberId,
    visibility: visibility === "personal" ? "personal" : visibility === "team" ? "team" : null,
    deviceId,
    agentKind,
  };
}

function buildInviteDeeplink(token: string): string {
  return `teamclaw://invite/${token}`;
}

export function createActorsApi(client: ActorsClient) {
  async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!client.rpc) throw new Error("Supabase RPC client is unavailable");
    const result = await client.rpc(name, args);
    throwIfError(result.error);
    return result.data;
  }

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
          .select(
            "id, agent_types, default_agent_type, default_workspace_id, owner_member_id, visibility, device_id",
          )
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
          agentById.get(row.id)?.default_workspace_id ?? null,
          agentById.get(row.id)?.owner_member_id ?? null,
          agentById.get(row.id)?.visibility ?? null,
          agentById.get(row.id)?.device_id ?? null,
        ),
      );
    },

    async removeActor(actorId: string): Promise<void> {
      await callRpc("remove_team_actor", { p_actor_id: actorId });
    },

    async updateAgentDefaults(
      agentId: string,
      patch: {
        defaultWorkspaceId?: string | null;
        defaultAgentType?: string | null;
      },
    ): Promise<void> {
      await callRpc("update_agent_defaults", {
        p_agent_id: agentId,
        p_default_workspace_id: patch.defaultWorkspaceId ?? null,
        p_agent_kind: null,
        p_default_agent_type: patch.defaultAgentType ?? null,
      });
    },

    async createReinvite({
      teamId,
      actor,
      ttlSeconds = 60 * 60 * 24 * 7,
    }: {
      teamId: string;
      actor: Actor;
      ttlSeconds?: number;
    }): Promise<ActorInviteResult> {
      const kind = actor.actorType === "agent" ? "agent" : "member";
      const data = await callRpc("create_team_invite", {
        p_team_id: teamId,
        p_kind: kind,
        p_display_name: actor.displayName,
        p_team_role: kind === "member" ? actor.role ?? "member" : null,
        p_agent_kind: kind === "agent" ? "daemon" : null,
        p_ttl_seconds: ttlSeconds,
        p_target_actor_id: actor.actorId,
      });
      const row = Array.isArray(data) ? data[0] : data;
      const record = row as { token?: string; deeplink?: string; expires_at?: string } | null;
      if (!record?.token) throw new Error("Invite created but token was missing.");
      return {
        token: record.token,
        deeplink: buildInviteDeeplink(record.token),
        expiresAt: record.expires_at ?? "",
      };
    },
  };
}
