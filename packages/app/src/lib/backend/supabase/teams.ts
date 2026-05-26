import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type { TeamInviteInput, TeamInviteResult, TeamSummary, TeamsBackend } from "../types";

type RpcResult = Promise<{ data: unknown; error: unknown | null }>;

type SupabaseTeamsClient = {
  rpc(name: string, args: Record<string, unknown>): RpcResult;
};

type TeamRpcRow = {
  id?: string;
  name?: string;
  slug?: string | null;
  created_at?: string | null;
  team_id?: string;
  team_name?: string;
  team_slug?: string | null;
};

type InviteRpcRow = {
  token?: string;
  invite_url?: string | null;
  inviteUrl?: string | null;
  deeplink?: string | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  actor_id?: string | null;
  actorId?: string | null;
};

function requiredString(value: unknown, operation: string, field: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw toBackendError({ message: `${operation} returned invalid ${field}` }, operation);
}

function firstRow<T>(data: unknown): T | null {
  return (Array.isArray(data) ? data[0] : data) as T | null;
}

function mapTeamSummary(data: unknown): TeamSummary {
  const row = firstRow<TeamRpcRow>(data);
  const id = row?.id ?? row?.team_id;
  const name = row?.name ?? row?.team_name;
  const summary: TeamSummary = {
    id: requiredString(id, "teams.mapTeamSummary", "id"),
    name: requiredString(name, "teams.mapTeamSummary", "name"),
  };
  const slug = row?.slug ?? row?.team_slug;
  if (slug !== undefined) summary.slug = slug;
  if (row?.created_at !== undefined) summary.created_at = row.created_at;
  return summary;
}

function mapInviteResult(data: unknown): TeamInviteResult {
  const row = firstRow<InviteRpcRow>(data);
  const inviteUrl = row?.invite_url ?? row?.inviteUrl ?? row?.deeplink ?? null;
  const result: TeamInviteResult = {
    token: requiredString(row?.token, "teams.mapInviteResult", "token"),
    inviteUrl,
    actorId: row?.actor_id ?? row?.actorId ?? null,
  };
  if (row?.deeplink !== undefined) result.deeplink = row.deeplink;
  const expiresAt = row?.expires_at ?? row?.expiresAt;
  if (expiresAt !== undefined) result.expiresAt = expiresAt;
  return result;
}

function inviteKind(input: TeamInviteInput): "member" | "agent" {
  return input.kind ?? input.actorType;
}

function inviteArgs(input: TeamInviteInput): Record<string, unknown> {
  const kind = input.kind ?? input.actorType;

  return {
    p_team_id: input.teamId,
    p_kind: kind,
    p_display_name: input.displayName ?? null,
    p_team_role: inviteKind(input) === "member" ? input.teamRole : null,
    p_agent_kind: inviteKind(input) === "agent" ? input.agentKind : null,
    p_ttl_seconds: input.ttlSeconds ?? null,
    p_target_actor_id: input.targetActorId ?? null,
  };
}

export function createSupabaseTeamsBackend(client: unknown = defaultSupabase): TeamsBackend {
  const supabase = client as SupabaseTeamsClient;

  return {
    async createTeam(input) {
      const args: Record<string, unknown> = {
        p_name: input.name,
      };
      if (input.slug !== undefined) args.p_slug = input.slug;
      const { data, error } = await supabase.rpc("create_team", args);
      if (error) throw toBackendError(error, "teams.createTeam");
      return mapTeamSummary(data);
    },
    async renameTeam(teamId, name) {
      const { data, error } = await supabase.rpc("rename_team", {
        p_team_id: teamId,
        p_name: name,
      });
      if (error) throw toBackendError(error, "teams.renameTeam");
      return mapTeamSummary(data);
    },
    async createTeamInvite(input) {
      const { data, error } = await supabase.rpc("create_team_invite", inviteArgs(input));
      if (error) throw toBackendError(error, "teams.createTeamInvite");
      return mapInviteResult(data);
    },
    async removeTeamActor(actorId) {
      const { error } = await supabase.rpc("remove_team_actor", { p_actor_id: actorId });
      if (error) throw toBackendError(error, "teams.removeTeamActor");
    },
  };
}
