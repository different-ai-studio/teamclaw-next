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

// PgDatabase base accepts both postgres-js and pglite drivers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeTeamsRepo(db: PgDatabase<any, any>) {
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
  };
}
