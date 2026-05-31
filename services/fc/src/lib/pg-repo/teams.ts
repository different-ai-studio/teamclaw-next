import { and, asc, eq, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { teams, teamWorkspaceConfig } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";

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
