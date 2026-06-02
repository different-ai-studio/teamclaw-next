import { and, asc, eq, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { teams, teamWorkspaceConfig, actors, members, teamMembers, teamInvites } from "../../db/schema/index.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agentMemberAccess, agents } from "../../db/schema/agents.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, checkAgentOwnership } from "./authz.js";
import { randomBytes } from "node:crypto";

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function mapTeam(r: any) {
  return {
    id: r.id, name: r.name, slug: r.slug, createdAt: iso(r.createdAt),
    shareMode: r.shareMode ?? null, shareEnabledAt: iso(r.shareEnabledAt),
    gitRemoteUrl: r.gitRemoteUrl ?? null, gitAuthKind: r.gitAuthKind ?? null,
  };
}

export interface TeamsRepoDeps {
  /**
   * LiteLLM provisioner — injected in production from team-provisioning.ts,
   * injected as a stub in tests.  If absent, setupLiteLlm throws 503.
   */
  provisionLiteLlm?: (teamName: string) => Promise<{ litellmTeamId: string; aiGatewayEndpoint: string; litellmKey: string } | null>;
}

// PgDatabase base accepts both postgres-js and pglite drivers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeTeamsRepo(db: PgDatabase<any, any>, deps: TeamsRepoDeps = {}) {
  return {
    async listTeams({ limit = 50 }: { limit?: number } = {}) {
      const rows = await db.select().from(teams).orderBy(asc(teams.createdAt)).limit(limit);
      return rows.map(mapTeam);
    },
    async getTeam(teamId: string) {
      const [r] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      return r ? mapTeam(r) : null;
    },
    async renameTeam(teamId: string, { name }: { name: string }) {
      const [r] = await (db.update(teams) as any).set({ name, updatedAt: new Date() }).where(eq(teams.id, teamId)).returning();
      if (!r) throw new ApiError(404, "not_found", "team not found");
      return mapTeam(r);
    },
    async getShareMode(teamId: string) {
      const [r] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      if (!r) return { mode: null, enabledAt: null, gitRemoteUrl: null, gitAuthKind: null };
      return { mode: r.shareMode ?? null, enabledAt: iso(r.shareEnabledAt), gitRemoteUrl: r.gitRemoteUrl ?? null, gitAuthKind: r.gitAuthKind ?? null };
    },
    async enableShareMode(teamId: string, mode: "oss" | "managed_git" | "custom_git", gitConfig: { remoteUrl?: string; authKind?: string; credentialRef?: string } | null) {
      const [r] = await (db.update(teams) as any)
        .set({
          shareMode: mode,
          shareEnabledAt: new Date(),
          gitRemoteUrl: gitConfig?.remoteUrl ?? null,
          gitAuthKind: gitConfig?.authKind ?? null,
          gitCredentialRef: gitConfig?.credentialRef ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(teams.id, teamId), isNull(teams.shareMode)))
        .returning();
      if (!r) {
        const [exists] = await db.select({ id: teams.id, sm: teams.shareMode }).from(teams).where(eq(teams.id, teamId)).limit(1);
        if (!exists) throw new ApiError(404, "not_found", "team not found");
        throw new ApiError(409, "conflict", "share_mode already locked");
      }
      return { id: r.id, shareMode: r.shareMode, shareEnabledAt: iso(r.shareEnabledAt), gitRemoteUrl: r.gitRemoteUrl ?? null, gitAuthKind: r.gitAuthKind ?? null };
    },
    async getTeamWorkspaceConfig(teamId: string) {
      const [r] = await db.select().from(teamWorkspaceConfig).where(eq(teamWorkspaceConfig.teamId, teamId)).limit(1);
      return r ?? null;
    },
    async putTeamWorkspaceConfig(teamId: string, input: Record<string, any>) {
      const [r] = await (db.insert(teamWorkspaceConfig) as any)
        .values({ teamId, ...input, updatedAt: new Date() })
        .onConflictDoUpdate({ target: teamWorkspaceConfig.teamId, set: { ...input, updatedAt: new Date() } })
        .returning();
      return r;
    },
    async getWorkspaceConfig(teamId: string) {
      const [t] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      const [wc] = await db.select().from(teamWorkspaceConfig).where(eq(teamWorkspaceConfig.teamId, teamId)).limit(1);
      return {
        shareMode: t?.shareMode ?? null,
        gitRemoteUrl: t?.gitRemoteUrl ?? null,
        gitAuthKind: t?.gitAuthKind ?? null,
        syncMode: wc?.syncMode ?? null,
        litellmTeamId: wc?.litellmTeamId ?? null,
      };
    },

    /**
     * Provisions a LiteLLM team for the given teamId.
     *
     * Requires a `provisionLiteLlm` function to be injected via `deps`.
     * In production this is the real FC provisioner; in tests a stub is used.
     *
     * Persists `litellmTeamId` + `aiGatewayEndpoint` into `team_workspace_config`.
     * Returns `{ aiGatewayEndpoint, litellmKey }`.
     */
    async setupLiteLlm(teamId: string) {
      const provisioner = deps.provisionLiteLlm;
      if (!provisioner) {
        throw new ApiError(
          503,
          "litellm_unavailable",
          "LiteLLM provisioning is not configured (provisionLiteLlm dependency missing)",
        );
      }

      // Resolve team name for use as a display alias in LiteLLM.
      const [teamRow] = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1);
      if (!teamRow) throw new ApiError(404, "not_found", "team not found");

      const provisioning = await provisioner(teamRow.name ?? teamId);
      if (!provisioning) {
        throw new ApiError(
          503,
          "litellm_unavailable",
          "LiteLLM provisioning is not configured (LITELLM_MASTER_KEY missing)",
        );
      }

      // Persist litellmTeamId + aiGatewayEndpoint into team_workspace_config.
      await (db.insert(teamWorkspaceConfig) as any)
        .values({
          teamId,
          litellmTeamId: provisioning.litellmTeamId,
          aiGatewayEndpoint: provisioning.aiGatewayEndpoint,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: teamWorkspaceConfig.teamId,
          set: {
            litellmTeamId: provisioning.litellmTeamId,
            aiGatewayEndpoint: provisioning.aiGatewayEndpoint,
            updatedAt: new Date(),
          },
        });

      return {
        aiGatewayEndpoint: provisioning.aiGatewayEndpoint,
        litellmKey: provisioning.litellmKey,
      };
    },

    /**
     * Creates a new team for the given userId.
     * First-team-only: rejects if the caller already has an actor in any team.
     * Inserts: teams → actors(member) → members(active) → team_members(owner)
     *          → workspaces('General') → team_workspace_config
     */
    async createTeam(input: { name: string; slug?: string; litellmTeamId?: string; aiGatewayEndpoint?: string }, ctx?: { userId?: string }) {
      const userId = ctx?.userId;
      if (!userId) throw new ApiError(400, "bad_request", "userId is required to create a team");

      return await (db as any).transaction(async (tx: any) => {
        // First-team-only: check if caller already has an actor in any team
        const [existingActor] = await tx
          .select({ id: actors.id })
          .from(actors)
          .where(eq(actors.userId, userId))
          .limit(1);
        if (existingActor) {
          throw new ApiError(409, "conflict", "user already belongs to a team");
        }

        // Slug dedup: if no slug provided or slug conflicts, generate one
        let slug = input.slug ?? (input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team");
        // Check for conflict and append random suffix if needed
        let attempt = 0;
        while (true) {
          const candidateSlug = attempt === 0 ? slug : `${slug}-${randomBytes(3).toString("hex")}`;
          const [existing] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.slug, candidateSlug)).limit(1);
          if (!existing) { slug = candidateSlug; break; }
          attempt++;
          if (attempt > 5) throw new ApiError(500, "internal_error", "could not generate unique slug");
        }

        // INSERT team
        const [team] = await tx.insert(teams).values({ name: input.name, slug }).returning();

        // INSERT actor (member type, linked to userId)
        const [actor] = await tx.insert(actors).values({
          teamId: team.id,
          actorType: "member",
          displayName: input.name,
          userId,
        }).returning();

        // INSERT member (active)
        await tx.insert(members).values({ id: actor.id, status: "active" });

        // INSERT team_member (owner role)
        await tx.insert(teamMembers).values({ teamId: team.id, memberId: actor.id, role: "owner" });

        // INSERT default workspace
        await tx.insert(workspaces).values({ teamId: team.id, name: "General", createdByMemberId: actor.id });

        // INSERT team_workspace_config
        await tx.insert(teamWorkspaceConfig).values({
          teamId: team.id,
          litellmTeamId: input.litellmTeamId ?? null,
          aiGatewayEndpoint: input.aiGatewayEndpoint ?? null,
        });

        return mapTeam(team);
      });
    },

    /**
     * Creates a team invite for the given teamId.
     * Resolves the caller's actorId via requireActorForTeam.
     * Returns { token, inviteId, expiresAt, deeplink }.
     */
    async createTeamInvite(
      teamId: string,
      input: { kind?: string; actorType?: string; displayName: string; teamRole?: string | null; role?: string; agentKind?: string | null; expiresAt?: string | null; ttlSeconds?: number | null; targetActorId?: string | null },
      ctx?: { userId?: string },
    ) {
      const userId = ctx?.userId;
      // Allow creating invites without a userId for tests / admin paths — use a null invitedByActorId fallback
      let invitedByActorId: string | null = null;
      if (userId) {
        invitedByActorId = await requireActorForTeam(db, userId, teamId);
      }

      // Derive canonical field values from either production keys (kind/teamRole) or legacy keys (actorType/role)
      const kind = input.kind ?? input.actorType ?? "member";
      const teamRole = input.teamRole !== undefined ? input.teamRole : (input.role ?? null);

      // Owner check: only the agent owner may re-invite an existing agent actor
      if (input.targetActorId) {
        if (!userId) throw new ApiError(401, "missing_identity", "re-inviting an agent requires authentication");
        const owns = await checkAgentOwnership(db, userId, input.targetActorId);
        if (!owns) throw new ApiError(403, "forbidden", "only the agent owner can re-invite this agent");
      }

      const token = randomBytes(24).toString("base64url");
      const ttlSeconds = input.ttlSeconds ?? 7 * 24 * 60 * 60; // 7 days default
      const expiresAt = input.expiresAt
        ? new Date(input.expiresAt)
        : new Date(Date.now() + ttlSeconds * 1000);

      const [invite] = await (db as any)
        .insert(teamInvites)
        .values({
          teamId,
          token,
          kind,
          teamRole,
          agentKind: input.agentKind ?? null,
          displayName: input.displayName,
          invitedByActorId: invitedByActorId ?? "00000000-0000-0000-0000-000000000000",
          expiresAt,
          targetActorId: input.targetActorId ?? null,
        })
        .returning();

      return {
        token: invite.token,
        inviteId: invite.id,
        expiresAt: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null,
        deeplink: null,
      };
    },

    /**
     * Removes an actor and all associated rows (cascade):
     * agentMemberAccess → team_members → agents/members → actors
     */
    async removeTeamActor(_teamId: string, actorId: string) {
      await (db as any).transaction(async (tx: any) => {
        // Delete agent_member_access rows where this actor is the member
        await tx.delete(agentMemberAccess).where(eq(agentMemberAccess.memberId, actorId));

        // Delete team_members rows for this actor (memberId = actorId for members)
        await tx.delete(teamMembers).where(eq(teamMembers.memberId, actorId));

        // Delete agents row (if actor is an agent)
        await tx.delete(agents).where(eq(agents.id, actorId));

        // Delete members row (if actor is a member)
        await tx.delete(members).where(eq(members.id, actorId));

        // Finally delete the actor itself
        await tx.delete(actors).where(eq(actors.id, actorId));
      });
    },

    /**
     * Loads the git-related columns from team_workspace_config.
     * Returns the raw row (null if absent) — matches supabase-repo shape.
     */
    async loadTeamWorkspaceGitConfig(teamId: string) {
      const [r] = await db
        .select({
          teamId: teamWorkspaceConfig.teamId,
          gitUrl: teamWorkspaceConfig.gitUrl,
          gitBranch: teamWorkspaceConfig.gitBranch,
          gitToken: teamWorkspaceConfig.gitToken,
          aiGatewayEndpoint: teamWorkspaceConfig.aiGatewayEndpoint,
          enabled: teamWorkspaceConfig.enabled,
          updatedAt: teamWorkspaceConfig.updatedAt,
        })
        .from(teamWorkspaceConfig)
        .where(eq(teamWorkspaceConfig.teamId, teamId))
        .limit(1);
      if (!r) return null;
      // Return in snake_case shape matching supabase-repo consumer expectations.
      return {
        team_id: r.teamId,
        git_url: r.gitUrl ?? null,
        git_branch: r.gitBranch ?? null,
        git_token: r.gitToken ?? null,
        ai_gateway_endpoint: r.aiGatewayEndpoint ?? null,
        enabled: r.enabled,
        updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      };
    },

    /**
     * Upserts git-related columns in team_workspace_config.
     * Accepts a plain object whose keys mirror the DB row (snake_case or camelCase).
     */
    async saveTeamWorkspaceGitConfig(input: Record<string, any>) {
      const teamId = input.team_id ?? input.teamId;
      if (!teamId) throw new ApiError(400, "bad_request", "team_id is required");

      const row: Record<string, any> = {
        teamId,
        updatedAt: new Date(),
      };
      if (input.git_url !== undefined) row.gitUrl = input.git_url;
      if (input.gitUrl !== undefined) row.gitUrl = input.gitUrl;
      if (input.git_branch !== undefined) row.gitBranch = input.git_branch;
      if (input.gitBranch !== undefined) row.gitBranch = input.gitBranch;
      if (input.git_token !== undefined) row.gitToken = input.git_token;
      if (input.gitToken !== undefined) row.gitToken = input.gitToken;
      if (input.ai_gateway_endpoint !== undefined) row.aiGatewayEndpoint = input.ai_gateway_endpoint;
      if (input.aiGatewayEndpoint !== undefined) row.aiGatewayEndpoint = input.aiGatewayEndpoint;
      if (input.enabled !== undefined) row.enabled = input.enabled;

      await (db.insert(teamWorkspaceConfig) as any)
        .values(row)
        .onConflictDoUpdate({
          target: teamWorkspaceConfig.teamId,
          set: { ...row, updatedAt: new Date() },
        });
    },
  };
}
