/**
 * Workspaces domain — pg-repo implementation.
 *
 * Row mapping notes:
 *  - slug    ← workspaces.path   (schema uses path; API/contract calls it slug)
 *  - metadata ← null             (not stored on workspaces table; kept for compat)
 *  - getTeamWorkspaceConfig / putTeamWorkspaceConfig return the contract shape
 *    {defaultWorkspaceId, pinnedWorkspaceIds} backed by the team_workspace_config
 *    columns added in migration 0003_complex_synch.sql.
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { workspaces, teamWorkspaceConfig } from "../../db/schema/index.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

function mapWorkspace(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    slug: r.path ?? null,
    archived: r.archived === true,
    metadata: null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

export function makeWorkspacesRepo(db: DbLike) {
  return {
    // ── List ──────────────────────────────────────────────────────────────
    async listWorkspaces({
      teamId,
      limit = 50,
      cursor = null,
      agentId = null,
    }: {
      teamId: string;
      limit?: number;
      cursor?: { updatedAt?: string } | null;
      agentId?: string | null;
    }) {
      const conditions: any[] = [eq(workspaces.teamId, teamId)];
      if (agentId) conditions.push(eq(workspaces.agentId, agentId));
      if (cursor?.updatedAt) conditions.push(lt(workspaces.updatedAt, new Date(cursor.updatedAt)));

      const rows = await (db
        .select()
        .from(workspaces)
        .where(and(...conditions))
        .orderBy(desc(workspaces.updatedAt), desc(workspaces.id))
        .limit(limit + 1) as any);

      const items = rows.slice(0, limit).map(mapWorkspace);
      return { items };
    },

    // ── Upsert ────────────────────────────────────────────────────────────
    async upsertWorkspace(input: {
      id: string;
      teamId: string;
      name: string;
      path?: string | null;
      agentId?: string | null;
      createdByMemberId?: string | null;
      archived?: boolean;
    }) {
      const [r] = await (db.insert(workspaces) as any)
        .values({
          id: input.id,
          teamId: input.teamId,
          name: input.name,
          path: input.path ?? null,
          agentId: input.agentId ?? null,
          createdByMemberId: input.createdByMemberId ?? null,
          archived: input.archived ?? false,
        })
        .onConflictDoUpdate({
          target: workspaces.id,
          set: {
            name: input.name,
            path: input.path ?? null,
            agentId: input.agentId ?? null,
            archived: input.archived ?? false,
            updatedAt: new Date(),
          },
        })
        .returning();
      return mapWorkspace(r);
    },

    // ── Get ───────────────────────────────────────────────────────────────
    async getWorkspace(workspaceId: string) {
      const [r] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      return r ? mapWorkspace(r) : null;
    },

    // ── Patch ─────────────────────────────────────────────────────────────
    async patchWorkspace(workspaceId: string, patch: { name?: string; archived?: boolean; slug?: string | null; path?: string | null; agentId?: string | null }) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.archived !== undefined) updates.archived = patch.archived;
      if (patch.slug !== undefined) updates.path = patch.slug;
      if (patch.path !== undefined) updates.path = patch.path;
      if (patch.agentId !== undefined) updates.agentId = patch.agentId;

      const [r] = await (db.update(workspaces) as any)
        .set(updates)
        .where(eq(workspaces.id, workspaceId))
        .returning();
      if (!r) return null;
      return mapWorkspace(r);
    },

    // ── List by IDs (slim) ────────────────────────────────────────────────
    async listWorkspacesByIdsSlim(teamId: string, workspaceIds: string[]) {
      if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) return [];
      const rows = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.teamId, teamId), inArray(workspaces.id, workspaceIds)));
      return rows.map(mapWorkspace);
    },

    // ── Team workspace defaults (defaultWorkspaceId / pinnedWorkspaceIds) ─
    async getTeamWorkspaceConfig(teamId: string) {
      const [r] = await db
        .select()
        .from(teamWorkspaceConfig)
        .where(eq(teamWorkspaceConfig.teamId, teamId))
        .limit(1);
      if (!r) return null;
      return {
        teamId: r.teamId,
        defaultWorkspaceId: r.defaultWorkspaceId ?? null,
        pinnedWorkspaceIds: (r.pinnedWorkspaceIds as string[] | null) ?? [],
        updatedAt: iso(r.updatedAt),
      };
    },

    async putTeamWorkspaceConfig(teamId: string, input: { defaultWorkspaceId?: string | null; pinnedWorkspaceIds?: string[] }) {
      const [r] = await (db.insert(teamWorkspaceConfig) as any)
        .values({
          teamId,
          defaultWorkspaceId: input.defaultWorkspaceId ?? null,
          pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [],
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: teamWorkspaceConfig.teamId,
          set: {
            defaultWorkspaceId: input.defaultWorkspaceId ?? null,
            pinnedWorkspaceIds: input.pinnedWorkspaceIds ?? [],
            updatedAt: new Date(),
          },
        })
        .returning();
      return {
        teamId: r.teamId,
        defaultWorkspaceId: r.defaultWorkspaceId ?? null,
        pinnedWorkspaceIds: (r.pinnedWorkspaceIds as string[] | null) ?? [],
        updatedAt: iso(r.updatedAt),
      };
    },
  };
}
