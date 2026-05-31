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
} from "../../db/schema/index.js";
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
  return {
    // ── List sessions (participant-filtered) ──────────────────────────────────
    async listSessions({
      teamId,
      actorId: explicitActorId,
      limit = 50,
      cursor = null,
    }: {
      teamId: string;
      actorId?: string | null;
      limit?: number;
      cursor?: { lastMessageAt?: string | null; createdAt?: string; id?: string } | null;
    }) {
      // Resolve the actor we'll use for participant filtering
      let actorId = explicitActorId ?? null;
      if (!actorId && ctx.userId) {
        actorId = await resolveActorForTeam(db, ctx.userId, teamId);
      }

      // Join sessions → session_participants to filter to only the actor's sessions.
      // Also left-join session_read_markers to compute hasUnread.
      // Ordering: lastMessageAt desc NULLS LAST, createdAt desc, id desc.

      // Build base query using SQL template for complex join + ordering
      const participantFilter = actorId
        ? sql`EXISTS (
            SELECT 1 FROM session_participants sp
            WHERE sp.session_id = sessions.id
              AND sp.actor_id = ${actorId}
          )`
        : sql`TRUE`;

      const cursorFilter = cursor?.lastMessageAt !== undefined
        ? sql`(
            sessions.last_message_at < ${cursor.lastMessageAt}
            OR (sessions.last_message_at IS NULL AND ${cursor.lastMessageAt} IS NOT NULL)
            OR (sessions.last_message_at IS NULL AND ${cursor.lastMessageAt} IS NULL AND sessions.created_at < ${cursor.createdAt ?? null})
            OR (sessions.last_message_at IS NULL AND ${cursor.lastMessageAt} IS NULL AND sessions.created_at = ${cursor.createdAt ?? null} AND sessions.id < ${cursor.id ?? null})
          )`
        : sql`TRUE`;

      // Read markers for the actor (to compute hasUnread)
      const readMarkerSubq = actorId
        ? sql`(
            SELECT srm.last_read_at FROM session_read_markers srm
            WHERE srm.session_id = sessions.id AND srm.actor_id = ${actorId}
            LIMIT 1
          )`
        : sql`NULL`;

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
        WHERE sessions.team_id = ${teamId}
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
    async markSessionViewed(sessionId: string, actorId?: string | null, lastReadMessageId?: string | null) {
      // Resolve actorId if not supplied
      let resolvedActorId = actorId ?? null;
      if (!resolvedActorId && ctx.userId) {
        // We need teamId for actor resolution — fetch from session
        const [s] = await db.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        if (s) {
          resolvedActorId = await resolveActorForTeam(db, ctx.userId, s.teamId);
        }
      }
      if (!resolvedActorId) return; // no actor to mark

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
