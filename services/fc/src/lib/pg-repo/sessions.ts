/**
 * Sessions + Participants domain — pg-repo implementation.
 *
 * Authz strategy:
 *  - listSessions accepts an explicit actorId (participant filter) or resolves
 *    from ctx.userId + teamId. This mirrors the Supabase RPC
 *    list_current_actor_sessions SECURITY DEFINER pattern.
 *  - markSessionViewed accepts explicit actorId or resolves from ctx.
 *  - Write paths (createSession, etc.) are trusted-caller paths — no JWT needed.
 *
 * RPC replacements:
 *  - list_current_actor_sessions   → listSessions (Drizzle join on participants)
 *  - mark_current_actor_session_viewed → markSessionViewed (upsert read marker)
 *  - ensure_gateway_session        → ensureGatewaySession (get-or-create on binding)
 */

import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  sessions,
  sessionParticipants,
  sessionReadMarkers,
  actors,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { resolveActorForTeam } from "./authz.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface SessionsCtx {
  userId?: string;
}

function mapSession(r: any) {
  return {
    id: r.id,
    teamId: r.teamId,
    title: r.title ?? "",
    mode: r.mode ?? "solo",
    ideaId: r.ideaId ?? null,
    lastMessageAt: iso(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview ?? null,
    hasUnread: r.hasUnread === true,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

function mapSessionFull(r: any, participants: any[] = []) {
  return {
    id: r.id,
    teamId: r.teamId,
    title: r.title ?? "",
    mode: r.mode ?? "solo",
    ideaId: r.ideaId ?? null,
    primaryAgentId: r.primaryAgentId ?? null,
    createdByActorId: r.createdByActorId ?? null,
    summary: r.summary ?? null,
    lastMessageAt: iso(r.lastMessageAt),
    lastMessagePreview: r.lastMessagePreview ?? null,
    hasUnread: false,
    acpSessionId: r.acpSessionId ?? null,
    binding: r.binding ?? null,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    participants,
  };
}

function mapParticipant(r: any) {
  return {
    sessionId: r.sessionId,
    actorId: r.actorId,
    role: r.role ?? null,
    joinedAt: iso(r.joinedAt),
  };
}

export function makeSessionsRepo(db: DbLike, ctx: SessionsCtx = {}) {
  // Resolve every actor id that belongs to the authenticated user (one per team).
  // Mirrors `app.current_actor_id()` semantics but across ALL the user's actors
  // rather than just the globally-oldest one — fixing the multi-team blind spot.
  async function resolveActorIdsForUser(userId: string): Promise<string[]> {
    const rows = await db
      .select({ id: actors.id })
      .from(actors)
      .where(eq(actors.userId, userId));
    return rows.map((r: any) => r.id).filter(Boolean);
  }

  return {
    // ── List sessions (participant-filtered) ──────────────────────────────────
    /**
     * AUTHZ (#10): lists the CURRENT ACTOR's sessions, resolved from ctx.userId.
     * The GET /v1/sessions route supplies neither teamId nor actorId, matching
     * the Supabase RPC `list_current_actor_sessions` (no team filter, scoped to
     * the authenticated user's participating sessions across all their teams).
     *
     * A client-supplied actorId is NEVER trusted. teamId is optional: when given
     * it narrows the result to that team (still scoped to the user's actors).
     * When no identity is available the result is empty (fail closed) — an
     * unauthenticated caller sees nothing rather than every team's sessions.
     */
    async listSessions({
      teamId,
      limit = 50,
      cursor = null,
    }: {
      teamId?: string;
      limit?: number;
      cursor?: { lastMessageAt?: string | null; createdAt?: string; id?: string } | null;
    } = {}) {
      // Resolve the caller's actor ids from the authenticated user.
      const actorIds = ctx.userId ? await resolveActorIdsForUser(ctx.userId) : [];
      if (actorIds.length === 0) {
        // No identity / no actors → no visible sessions (fail closed).
        return [];
      }

      // Participant filter: any of the user's actors participates in the session.
      const participantFilter = sql`EXISTS (
            SELECT 1 FROM session_participants sp
            WHERE sp.session_id = sessions.id
              AND sp.actor_id IN (${sql.join(actorIds, sql`, `)})
          )`;

      // Optional team narrowing (scoped to the user's actors regardless).
      const teamFilter = teamId ? sql`sessions.team_id = ${teamId}` : sql`TRUE`;

      const cursorFilter = cursor?.lastMessageAt !== undefined
        ? sql`(
            sessions.last_message_at < ${cursor.lastMessageAt}
            OR (sessions.last_message_at IS NULL AND ${cursor.lastMessageAt} IS NOT NULL)
            OR (sessions.last_message_at IS NULL AND ${cursor.lastMessageAt} IS NULL AND sessions.created_at < ${cursor.createdAt ?? null})
            OR (sessions.last_message_at IS NULL AND ${cursor.lastMessageAt} IS NULL AND sessions.created_at = ${cursor.createdAt ?? null} AND sessions.id < ${cursor.id ?? null})
          )`
        : sql`TRUE`;

      // Read markers for any of the user's actors (to compute hasUnread).
      const readMarkerSubq = sql`(
            SELECT MIN(srm.last_read_at) FROM session_read_markers srm
            WHERE srm.session_id = sessions.id
              AND srm.actor_id IN (${sql.join(actorIds, sql`, `)})
          )`;

      const rows = await (db as any).execute(sql`
        SELECT
          sessions.id,
          sessions.team_id AS "teamId",
          sessions.idea_id AS "ideaId",
          sessions.mode,
          sessions.title,
          sessions.last_message_preview AS "lastMessagePreview",
          sessions.last_message_at AS "lastMessageAt",
          sessions.created_at AS "createdAt",
          sessions.updated_at AS "updatedAt",
          CASE
            WHEN sessions.last_message_at IS NULL THEN FALSE
            WHEN (${readMarkerSubq}) IS NULL THEN TRUE
            WHEN (${readMarkerSubq}) < sessions.last_message_at THEN TRUE
            ELSE FALSE
          END AS "hasUnread"
        FROM sessions
        WHERE (${teamFilter})
          AND (${participantFilter})
          AND (${cursorFilter})
        ORDER BY
          sessions.last_message_at DESC NULLS LAST,
          sessions.created_at DESC,
          sessions.id DESC
        LIMIT ${limit}
      `);

      const result = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      return result.map((r: any) => ({
        id: r.id,
        teamId: r.teamId,
        title: r.title ?? "",
        mode: r.mode ?? "solo",
        ideaId: r.ideaId ?? null,
        lastMessageAt: iso(r.lastMessageAt),
        lastMessagePreview: r.lastMessagePreview ?? null,
        hasUnread: r.hasUnread === true,
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
      }));
    },

    // ── getSession ────────────────────────────────────────────────────────────
    async getSession(sessionId: string) {
      const [r] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!r) return null;
      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── createSession ─────────────────────────────────────────────────────────
    async createSession(input: {
      id?: string;
      teamId: string;
      title: string;
      mode?: string;
      ideaId?: string | null;
      createdByActorId?: string;
      primaryAgentId?: string;
      participantActorIds?: string[];
      additionalActorIds?: string[];
    }) {
      const id = input.id ?? crypto.randomUUID();
      const insertRow: any = {
        id,
        teamId: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        ideaId: input.ideaId ?? null,
      };
      if (input.createdByActorId) insertRow.createdByActorId = input.createdByActorId;
      if (input.primaryAgentId) insertRow.primaryAgentId = input.primaryAgentId;

      const [r] = await (db.insert(sessions) as any).values(insertRow).returning();

      // Bootstrap participants
      const participantIds = Array.from(
        new Set(
          [
            input.createdByActorId,
            ...(input.participantActorIds ?? []),
            ...(input.additionalActorIds ?? []),
          ].filter((x): x is string => typeof x === "string" && x.length > 0),
        ),
      );

      let parts: any[] = [];
      if (participantIds.length > 0) {
        parts = await (db.insert(sessionParticipants) as any)
          .values(participantIds.map((actorId) => ({ sessionId: id, actorId })))
          .onConflictDoNothing()
          .returning();
      }

      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── patchSession ──────────────────────────────────────────────────────────
    async patchSession(sessionId: string, patch: { title?: string; summary?: string; mode?: string; archivedAt?: string | null }) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.title !== undefined) updates.title = patch.title;
      if (patch.summary !== undefined) updates.summary = patch.summary;
      if (patch.mode !== undefined) updates.mode = patch.mode;

      const [r] = await (db.update(sessions) as any)
        .set(updates)
        .where(eq(sessions.id, sessionId))
        .returning();
      if (!r) return null;

      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── getSessionByAcp ───────────────────────────────────────────────────────
    async getSessionByAcp(acpSessionId: string) {
      const [r] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.acpSessionId, acpSessionId))
        .limit(1);
      if (!r) return null;
      const parts = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, r.id));
      return mapSessionFull(r, parts.map(mapParticipant));
    },

    // ── markSessionViewed ─────────────────────────────────────────────────────
    /**
     * AUTHZ (#10): the read marker's actor is ALWAYS resolved server-side from
     * ctx.userId + the session's team — never from a client-supplied actor — so a
     * caller cannot mark a session read on behalf of someone else.
     *
     * Signature matches the Supabase backend: (sessionId, lastReadMessageId).
     * The optional 2nd-positional explicit actorId is reserved for trusted
     * server/gateway callers that operate WITHOUT an authenticated user
     * (ctx.userId absent); pass it as `{ actorId }`. The route never does.
     *
     * Fails CLOSED: with an authenticated user but no actor in the session's team
     * (or a missing session) it throws 403/404 rather than silently no-opping. A
     * call with neither ctx.userId nor a trusted actorId throws 401.
     */
    async markSessionViewed(
      sessionId: string,
      lastReadMessageId?: string | null,
      trusted?: { actorId?: string | null },
    ) {
      let resolvedActorId: string | null = null;

      if (ctx.userId) {
        // Authenticated path — resolve from the session's team. Authoritative.
        const [s] = await db.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (!s) throw new ApiError(404, "not_found", "session not found");
        resolvedActorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
        if (!resolvedActorId) {
          throw new ApiError(403, "forbidden", "not a member of this session's team");
        }
      } else if (trusted?.actorId) {
        // Trusted server/gateway caller (no JWT) — accept the explicit actor.
        resolvedActorId = trusted.actorId;
      } else {
        // No identity at all — fail closed.
        throw new ApiError(401, "missing_auth", "cannot resolve actor for mark-viewed");
      }

      await (db.insert(sessionReadMarkers) as any)
        .values({
          sessionId,
          actorId: resolvedActorId,
          lastReadAt: new Date(),
          lastReadMessageId: lastReadMessageId ?? null,
        })
        .onConflictDoUpdate({
          target: [sessionReadMarkers.sessionId, sessionReadMarkers.actorId],
          set: {
            lastReadAt: new Date(),
            lastReadMessageId: lastReadMessageId ?? null,
            updatedAt: new Date(),
          },
        });
    },

    /**
     * Mark a session unread for the calling actor by deleting their read
     * marker, so the session re-derives as unread. Actor resolution + fail-closed
     * semantics mirror markSessionViewed.
     */
    async markSessionUnread(sessionId: string, trusted?: { actorId?: string | null }) {
      let resolvedActorId: string | null = null;

      if (ctx.userId) {
        const [s] = await db
          .select({ teamId: sessions.teamId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!s) throw new ApiError(404, "not_found", "session not found");
        resolvedActorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
        if (!resolvedActorId) {
          throw new ApiError(403, "forbidden", "not a member of this session's team");
        }
      } else if (trusted?.actorId) {
        resolvedActorId = trusted.actorId;
      } else {
        throw new ApiError(401, "missing_auth", "cannot resolve actor for mark-unread");
      }

      await db
        .delete(sessionReadMarkers)
        .where(
          and(
            eq(sessionReadMarkers.sessionId, sessionId),
            eq(sessionReadMarkers.actorId, resolvedActorId),
          ),
        );
    },

    // ── ensureGatewaySession ──────────────────────────────────────────────────
    /**
     * Idempotent get-or-create on the (teamId, binding) unique key.
     * Returns { sessionId, gatewaySessionId, created }.
     * gatewaySessionId = the binding string (acts as the external gateway session id).
     */
    async ensureGatewaySession(input: {
      teamId: string;
      binding: string;
      title: string;
      primaryAgentActorId: string;
      ownerMemberActorIds: string[];
      participantActorIds: string[];
    }) {
      // Try to find existing session by binding
      const [existing] = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.teamId, input.teamId), eq(sessions.binding, input.binding)))
        .limit(1);

      if (existing) {
        return {
          sessionId: existing.id,
          gatewaySessionId: existing.binding ?? existing.id,
          acpSessionId: existing.acpSessionId ?? null,
          created: false,
        };
      }

      // Create new session with binding
      const id = crypto.randomUUID();
      const [r] = await (db.insert(sessions) as any)
        .values({
          id,
          teamId: input.teamId,
          title: input.title,
          mode: "gateway",
          primaryAgentId: input.primaryAgentActorId,
          createdByActorId: input.primaryAgentActorId,
          binding: input.binding,
        })
        .returning();

      // Bootstrap participants: primary agent + owner members + participants
      const participantIds = Array.from(
        new Set([
          input.primaryAgentActorId,
          ...input.ownerMemberActorIds,
          ...input.participantActorIds,
        ].filter((x): x is string => typeof x === "string" && x.length > 0)),
      );

      if (participantIds.length > 0) {
        await (db.insert(sessionParticipants) as any)
          .values(participantIds.map((actorId) => ({ sessionId: id, actorId })))
          .onConflictDoNothing();
      }

      return {
        sessionId: r.id,
        gatewaySessionId: r.binding ?? r.id,
        acpSessionId: r.acpSessionId ?? null,
        created: true,
      };
    },

    // ── createCronSession ─────────────────────────────────────────────────────
    async createCronSession(input: {
      id?: string;
      teamId: string;
      primaryAgentActorId: string;
      title: string;
      createdByActorId?: string;
    }) {
      const id = input.id ?? crypto.randomUUID();
      const [r] = await (db.insert(sessions) as any)
        .values({
          id,
          teamId: input.teamId,
          title: input.title,
          mode: "collab",
          primaryAgentId: input.primaryAgentActorId,
          createdByActorId: input.createdByActorId ?? input.primaryAgentActorId,
        })
        .returning();

      // Bootstrap primary agent as participant
      await (db.insert(sessionParticipants) as any)
        .values([{ sessionId: id, actorId: input.primaryAgentActorId }])
        .onConflictDoNothing();

      return { sessionId: r.id, ...mapSessionFull(r, []) };
    },

    // ── listTeamSessionsFull ──────────────────────────────────────────────────
    async listTeamSessionsFull(teamId: string) {
      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.teamId, teamId))
        .orderBy(desc(sessions.lastMessageAt));

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const partRows = await db
        .select({ sessionId: sessionParticipants.sessionId })
        .from(sessionParticipants)
        .where(inArray(sessionParticipants.sessionId, ids));

      const counts: Record<string, number> = {};
      for (const p of partRows) {
        counts[p.sessionId] = (counts[p.sessionId] ?? 0) + 1;
      }

      return rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        title: r.title ?? "",
        mode: r.mode ?? "solo",
        ideaId: r.ideaId ?? null,
        primaryAgentId: r.primaryAgentId ?? null,
        createdByActorId: r.createdByActorId ?? null,
        summary: r.summary ?? null,
        lastMessageAt: iso(r.lastMessageAt),
        lastMessagePreview: r.lastMessagePreview ?? null,
        participantCount: counts[r.id] ?? 0,
        hasUnread: false,
        createdAt: iso(r.createdAt)!,
        updatedAt: iso(r.updatedAt)!,
      }));
    },

    // ── listSessionsForTeamSince ──────────────────────────────────────────────
    async listSessionsForTeamSince(teamId: string, updatedAfter: string | null) {
      let query = db.select().from(sessions).where(eq(sessions.teamId, teamId)) as any;
      if (updatedAfter) {
        query = db
          .select()
          .from(sessions)
          .where(and(eq(sessions.teamId, teamId), gt(sessions.updatedAt, new Date(updatedAfter))));
      }
      return query;
    },

    // ── listSessionDisplayRows ────────────────────────────────────────────────
    async listSessionDisplayRows(teamId: string, sessionIds: string[]) {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
      const rows = await db
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(and(eq(sessions.teamId, teamId), inArray(sessions.id, sessionIds)));
      return rows;
    },

    // ── listSessionIdsForActor ────────────────────────────────────────────────
    async listSessionIdsForActor(actorId: string) {
      const rows = await db
        .select({ sessionId: sessionParticipants.sessionId })
        .from(sessionParticipants)
        .where(eq(sessionParticipants.actorId, actorId));
      return rows.map((r) => r.sessionId).filter(Boolean);
    },

    // ── listSessionParticipants ───────────────────────────────────────────────
    async listSessionParticipants(sessionId: string) {
      const rows = await db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId));
      return { items: rows.map(mapParticipant) };
    },

    // ── upsertSessionParticipant ──────────────────────────────────────────────
    async upsertSessionParticipant(
      sessionId: string,
      input: { actorId: string; role?: string | null },
    ) {
      const row: any = { sessionId, actorId: input.actorId };
      if (input.role !== undefined) row.role = input.role;

      const [r] = await (db.insert(sessionParticipants) as any)
        .values(row)
        .onConflictDoUpdate({
          target: [sessionParticipants.sessionId, sessionParticipants.actorId],
          set: {
            role: input.role ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();

      return {
        sessionId: r.sessionId,
        actorId: r.actorId,
        role: r.role ?? null,
        joinedAt: iso(r.joinedAt),
      };
    },

    // ── removeSessionParticipant ──────────────────────────────────────────────
    async removeSessionParticipant(sessionId: string, actorId: string) {
      await (db.delete(sessionParticipants) as any)
        .where(
          and(
            eq(sessionParticipants.sessionId, sessionId),
            eq(sessionParticipants.actorId, actorId),
          ),
        );
    },

    // ── listSessionParticipantsForSync ────────────────────────────────────────
    async listSessionParticipantsForSync(sessionId: string, updatedAfter: string | null) {
      let query = db
        .select()
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, sessionId)) as any;
      if (updatedAfter) {
        query = db
          .select()
          .from(sessionParticipants)
          .where(
            and(
              eq(sessionParticipants.sessionId, sessionId),
              gt(sessionParticipants.updatedAt, new Date(updatedAfter)),
            ),
          );
      }
      return query;
    },
  };
}
