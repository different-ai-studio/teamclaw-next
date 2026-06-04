/**
 * Actors / Directory domain — pg-repo implementation.
 *
 * Contract methods implemented here:
 *  - getActor(id)
 *  - upsertExternalActor({ teamId, source, sourceId, displayName })
 *  - listTeamActors(teamId, { kind, limit })
 *  - getTeamDirectory(teamId)
 *
 * Agent-visibility filter:
 *   The actor_directory VIEW is caller-independent (returns ALL actors).
 *   Visibility filtering happens here:
 *     - member actors always included
 *     - agents included when agentVisibility='team' OR ownerMemberId=<callerActorId>
 *   When no callerActorId is available (e.g. internal/contract calls), we include
 *   all team-visible agents (matching Supabase default behavior).
 */

import { and, desc, eq, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, agents, members, teamMembers, actorDirectory, actorClientVersions } from "../../db/schema/index.js";
import { resolveActorForTeam, requireActorForTeam } from "./authz.js";
import { ApiError } from "../http-utils.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface ActorsCtx {
  userId?: string;
  /** resolved actor id for the calling team — set by the route layer when available */
  callerActorId?: string;
}

function mapActorRow(r: any) {
  return {
    id: r.id as string,
    teamId: r.teamId as string,
    kind: (r.actorType ?? r.kind) as string,
    displayName: r.displayName as string,
    avatarUrl: (r.avatarUrl ?? null) as string | null,
    metadata: null as null,
  };
}

function mapMemberRow(r: any) {
  return {
    actorId: r.id as string,
    teamId: r.teamId as string,
    role: r.teamRole as string,
    joinedAt: iso(r.createdAt)!,
  };
}

/** Visibility filter expression for actor_directory queries */
function visibilityFilter(callerActorId?: string) {
  // Include non-agent actors always.
  // For agents: include if team-visible OR owned by caller (when known).
  if (callerActorId) {
    return or(
      sql`${actorDirectory.actorType} <> 'agent'`,
      eq(actorDirectory.agentVisibility, "team"),
      eq(actorDirectory.ownerMemberId, callerActorId),
    );
  }
  return or(
    sql`${actorDirectory.actorType} <> 'agent'`,
    eq(actorDirectory.agentVisibility, "team"),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeActorsRepo(db: DbLike, ctx: ActorsCtx = {}) {
  return {
    /**
     * Returns `{ displayName }` for the given actor id, or null if not found.
     */
    async getActor(id: string) {
      const [r] = await db
        .select({ id: actors.id, displayName: actors.displayName })
        .from(actors)
        .where(eq(actors.id, id))
        .limit(1);
      if (!r) return null;
      const versions = await db
        .select({
          clientType: actorClientVersions.clientType,
          version: actorClientVersions.version,
          deviceId: actorClientVersions.deviceId,
          build: actorClientVersions.build,
          lastReportedAt: actorClientVersions.lastReportedAt,
        })
        .from(actorClientVersions)
        .where(eq(actorClientVersions.actorId, id))
        .orderBy(actorClientVersions.clientType, desc(actorClientVersions.lastReportedAt));
      return {
        displayName: r.displayName,
        clientVersions: versions.map((v) => ({
          clientType: v.clientType,
          version: v.version,
          deviceId: v.deviceId,
          build: v.build ?? null,
          lastReportedAt:
            v.lastReportedAt instanceof Date ? v.lastReportedAt.toISOString() : v.lastReportedAt,
        })),
      };
    },

    /**
     * Upserts an external actor (e.g. WeCom contact) identified by source+sourceId.
     * Uses a get-or-create pattern safe against races.
     *
     * Supabase RPC `upsert_external_actor` is replaced by this Drizzle approach:
     *   1. Look for an existing actor in the team whose displayName is a sentinel match
     *      — we use userId = `${source}:${sourceId}` as the lookup key.
     *   2. If found, update displayName; if not, insert a new actor row with
     *      actorType='external'.
     */
    async upsertExternalActor({ teamId, source, sourceId, displayName }: {
      teamId: string;
      source: string;
      sourceId: string;
      displayName: string;
    }) {
      const userId = `${source}:${sourceId}`;
      // Try update first (race-safe: unique index on team_id + user_id)
      const updated = await (db.update(actors) as any)
        .set({ displayName, updatedAt: new Date() })
        .where(and(eq(actors.teamId, teamId), eq(actors.userId, userId)))
        .returning({ id: actors.id });

      if (updated.length > 0) {
        return { actorId: updated[0].id as string };
      }

      // Insert — may race but the unique index will protect us; caller can retry on conflict
      const [inserted] = await (db.insert(actors) as any)
        .values({ teamId, actorType: "external", displayName, userId })
        .returning({ id: actors.id });
      return { actorId: inserted.id as string };
    },

    /**
     * Lists actors in a team, with optional kind filter.
     * Returns paged result: `{ items }`.
     * agent-visibility filter applied at query time.
     */
    async listTeamActors(teamId: string, { kind = null, limit = 200 }: { kind?: string | null; limit?: number } = {}) {
      const callerActorId = ctx.callerActorId ?? (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) ?? undefined : undefined);
      const visFilter = visibilityFilter(callerActorId);
      const conditions = [
        eq(actorDirectory.teamId, teamId),
        visFilter!,
      ];
      if (kind) {
        conditions.push(eq(actorDirectory.actorType, kind));
      }

      const rows = await db
        .select()
        .from(actorDirectory)
        .where(and(...conditions))
        .limit(limit);

      return {
        items: rows.map(mapActorRow),
      };
    },

    /**
     * Returns the full directory for a team: all actors + member join info.
     * agent-visibility filter applied at query time.
     */
    async getTeamDirectory(teamId: string) {
      const callerActorId = ctx.callerActorId ?? (ctx.userId ? await resolveActorForTeam(db, ctx.userId, teamId) ?? undefined : undefined);
      const visFilter = visibilityFilter(callerActorId);
      const rows = await db
        .select()
        .from(actorDirectory)
        .where(and(eq(actorDirectory.teamId, teamId), visFilter!));

      const actorsList = rows.map(mapActorRow);
      const membersList = rows
        .filter((r: any) => r.actorType === "member" && r.teamRole)
        .map(mapMemberRow);

      return { actors: actorsList, members: membersList };
    },

    /**
     * Updates display_name / avatar_url for the given actor and returns the
     * directory-actor shape (consistent with getActor/listTeamActors).
     */
    async updateCurrentActorProfile(actorId: string, { displayName, avatarUrl }: { displayName?: string; avatarUrl?: string }) {
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (displayName !== undefined) set.displayName = displayName;
      if (avatarUrl !== undefined) set.avatarUrl = avatarUrl;
      const [r] = await (db.update(actors) as any)
        .set(set)
        .where(eq(actors.id, actorId))
        .returning();
      if (!r) throw new ApiError(404, "not_found", "actor not found");
      return mapActorRow(r);
    },

    /**
     * Returns actor_directory rows for a team updated after the given cursor.
     * Used by the sync-v1 incremental sync endpoint.
     * No visibility filter applied — matches the permissive Supabase behavior
     * used by the sync service which already runs with elevated privileges.
     */
    async listActorDirectoryForSync(teamId: string, updatedAfter: string | null) {
      const conditions = [eq(actorDirectory.teamId, teamId)];
      if (updatedAfter) {
        conditions.push(sql`${actorDirectory.updatedAt} > ${updatedAfter}::timestamptz`);
      }
      const rows = await db
        .select({
          id: actorDirectory.id,
          teamId: actorDirectory.teamId,
          actorType: actorDirectory.actorType,
          displayName: actorDirectory.displayName,
          memberStatus: actorDirectory.memberStatus,
          agentStatus: actorDirectory.agentStatus,
          lastActiveAt: actorDirectory.lastActiveAt,
          createdAt: actorDirectory.createdAt,
          updatedAt: actorDirectory.updatedAt,
        })
        .from(actorDirectory)
        .where(and(...conditions));
      return rows.map((r: any) => ({
        id: r.id,
        team_id: r.teamId,
        actor_type: r.actorType,
        display_name: r.displayName,
        member_status: r.memberStatus ?? null,
        agent_status: r.agentStatus ?? null,
        last_active_at: r.lastActiveAt ? new Date(r.lastActiveAt).toISOString() : null,
        created_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
      }));
    },

    /**
     * Returns the calling member's default agent for a team: `{ defaultAgentId }`
     * (null when unset). The caller's own actor is resolved server-side from the
     * JWT — never supplied by the client.
     */
    async getMemberDefaultAgent(teamId: string) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);
      const [r] = await db
        .select({ defaultAgentId: members.defaultAgentId })
        .from(members)
        .where(eq(members.id, callerActorId))
        .limit(1);
      return { defaultAgentId: (r?.defaultAgentId ?? null) as string | null };
    },

    /**
     * Sets (agentId) or clears (null) the calling member's default agent.
     * Rejects an agent that is not in the team, not active, or not visible to
     * the caller (personal agents owned by someone else) — 409 for the former
     * two, 403 for visibility. Returns `{ defaultAgentId }`.
     */
    async setMemberDefaultAgent(teamId: string, agentId: string | null) {
      if (!ctx.userId) throw new ApiError(401, "missing_identity", "authentication required");
      const callerActorId = await requireActorForTeam(db, ctx.userId, teamId);

      if (agentId != null) {
        const [ag] = await db
          .select({
            teamId: actors.teamId,
            actorType: actors.actorType,
            status: agents.status,
            visibility: agents.visibility,
            ownerMemberId: agents.ownerMemberId,
          })
          .from(actors)
          .innerJoin(agents, eq(agents.id, actors.id))
          .where(eq(actors.id, agentId))
          .limit(1);
        if (!ag || ag.actorType !== "agent" || ag.teamId !== teamId) {
          throw new ApiError(409, "invalid_agent", "agent is not in this team");
        }
        if (ag.status !== "active") {
          throw new ApiError(409, "invalid_agent", "agent is not active");
        }
        const visible = ag.visibility === "team" || ag.ownerMemberId === callerActorId;
        if (!visible) {
          throw new ApiError(403, "forbidden", "agent is not visible to caller");
        }
      }

      const [r] = await (db.update(members) as any)
        .set({ defaultAgentId: agentId, updatedAt: new Date() })
        .where(eq(members.id, callerActorId))
        .returning({ defaultAgentId: members.defaultAgentId });
      if (!r) throw new ApiError(404, "not_found", "member not found");
      return { defaultAgentId: (r.defaultAgentId ?? null) as string | null };
    },
  };
}
