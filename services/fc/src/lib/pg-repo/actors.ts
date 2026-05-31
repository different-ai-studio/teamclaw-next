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

import { and, eq, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, members, teamMembers, actorDirectory } from "../../db/schema/index.js";

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
      return { displayName: r.displayName };
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
      const visFilter = visibilityFilter(ctx.callerActorId);
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
      const visFilter = visibilityFilter(ctx.callerActorId);
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
  };
}
