import type { TeamSummary, TeamsBackend, TeamInviteInput, TeamInviteResult } from "../types";
import type { CloudApiClient } from "./http";

type CloudTeam = {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string | null;
};

type CloudInvite = {
  token: string;
  inviteUrl?: string | null;
  deeplink?: string | null;
  expiresAt?: string | null;
  actorId?: string | null;
};

function mapTeam(row: CloudTeam): TeamSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt,
  };
}

function mapInvite(row: CloudInvite): TeamInviteResult {
  return {
    token: row.token,
    inviteUrl: row.inviteUrl ?? row.deeplink ?? null,
    deeplink: row.deeplink ?? null,
    expiresAt: row.expiresAt ?? null,
    actorId: row.actorId ?? null,
  };
}

type Page<T> = { items: T[]; nextCursor: string | null };

export function createTeamsModule(client: CloudApiClient, delegate: TeamsBackend): TeamsBackend {
  return {
    ...delegate,
    async listCurrentUserTeams(args = {}) {
      const limit = args.limit ?? 50;
      const page = await client.get<Page<CloudTeam>>(`/v1/teams?limit=${encodeURIComponent(String(limit))}`);
      return page.items.map(mapTeam);
    },
    async getTeam(teamId: string) {
      return mapTeam(await client.get<CloudTeam>(`/v1/teams/${encodeURIComponent(teamId)}`));
    },
    async createTeam(input) {
      return mapTeam(await client.post<CloudTeam>("/v1/teams", input));
    },
    async renameTeam(teamId: string, name: string) {
      return mapTeam(await client.patch<CloudTeam>(`/v1/teams/${encodeURIComponent(teamId)}`, { name }));
    },
    async createTeamInvite(input: TeamInviteInput) {
      const kind = input.kind ?? input.actorType;
      const body = {
        teamId: input.teamId,
        kind,
        displayName: input.displayName ?? null,
        teamRole: kind === "member" ? input.teamRole : null,
        agentKind: kind === "agent" ? input.agentKind : null,
        ttlSeconds: input.ttlSeconds ?? null,
        targetActorId: input.targetActorId ?? null,
      };
      return mapInvite(await client.post<CloudInvite>(`/v1/teams/${encodeURIComponent(input.teamId)}/invites`, body));
    },
    async removeTeamActor(actorId: string) {
      // The FC endpoint uses /v1/teams/:teamId/members/:actorId but we don't have teamId here.
      // Fall back to delegate which has the RPC context.
      return delegate.removeTeamActor(actorId);
    },
  };
}
