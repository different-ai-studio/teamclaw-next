/**
 * Agents domain — pg-repo implementation.
 *
 * Owner-gated mutations (updateOwnedAgentProfile, shareAgentToTeam,
 * makeAgentPersonal) use team-scoped owner resolution via
 * resolveActorForAgent + checkAgentOwnership — never the bugged global
 * current_member_id().
 *
 * checkAgentPermission(agentId, actorId) → { allowed, role } reads from
 * agentMemberAccess directly.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { actors, agents, agentMemberAccess } from "../../db/schema/index.js";
import {
  resolveActorForAgent,
  checkAgentOwnership,
  checkAgentPermission as authzCheckAgentPermission,
} from "./authz.js";
import { ApiError } from "../http-utils.js";

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface AgentsCtx {
  userId?: string;
  callerActorId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeAgentsRepo(db: DbLike, ctx: AgentsCtx = {}) {
  return {
    /**
     * Lists all agent actors connected to a team (visibility = team OR personal
     * when owned by caller). Returns items with kind="agent".
     *
     * Replaces the list_connected_agents RPC.
     */
    async listConnectedAgents(teamId: string) {
      // Join actors + agents for the given team
      const rows = await db
        .select({
          id: actors.id,
          teamId: actors.teamId,
          displayName: actors.displayName,
          avatarUrl: actors.avatarUrl,
          actorType: actors.actorType,
          agentKind: agents.agentKind,
          status: agents.status,
          visibility: agents.visibility,
          ownerMemberId: agents.ownerMemberId,
          agentTypes: agents.agentTypes,
          defaultAgentType: agents.defaultAgentType,
          defaultWorkspaceId: agents.defaultWorkspaceId,
          deviceId: agents.deviceId,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(actors)
        .innerJoin(agents, eq(agents.id, actors.id))
        .where(eq(actors.teamId, teamId));

      const callerActorId = ctx.callerActorId;
      const items = rows
        .filter(
          (r) =>
            r.visibility === "team" ||
            (callerActorId && r.ownerMemberId === callerActorId),
        )
        .map((r) => ({
          id: r.id,
          teamId: r.teamId,
          kind: "agent" as const,
          displayName: r.displayName,
          avatarUrl: r.avatarUrl ?? null,
          agentKind: r.agentKind,
          status: r.status ?? null,
          visibility: r.visibility ?? null,
          ownerMemberId: r.ownerMemberId ?? null,
          isOwner: callerActorId ? r.ownerMemberId === callerActorId : false,
          agentTypes: r.agentTypes ?? null,
          defaultAgentType: r.defaultAgentType ?? null,
          defaultWorkspaceId: r.defaultWorkspaceId ?? null,
          agentId: r.id,
          deviceId: r.deviceId ?? null,
          permissionLevel: null,
          createdAt: iso(r.createdAt),
          updatedAt: iso(r.updatedAt),
        }));

      return { items };
    },

    /**
     * Returns { allowed, role } for (agentId, actorId).
     * allowed=true + role=string when an agentMemberAccess row exists;
     * allowed=false + role=null when not.
     *
     * Replaces check_agent_permission RPC.
     */
    async checkAgentPermission(agentId: string, actorId: string) {
      const role = await authzCheckAgentPermission(db, actorId, agentId);
      return { allowed: role !== null, role };
    },

    /**
     * Grants (or updates) access for actorId on agentId.
     * Returns { actorId, role }.
     *
     * Replaces the agent_member_access upsert via PostgREST.
     */
    async grantAgentAccess(
      agentId: string,
      { actorId, role }: { actorId: string; role: string },
    ) {
      // Upsert on (agentId, memberId)
      const existing = await db
        .select({ id: agentMemberAccess.id })
        .from(agentMemberAccess)
        .where(
          and(
            eq(agentMemberAccess.agentId, agentId),
            eq(agentMemberAccess.memberId, actorId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await (db.update(agentMemberAccess) as any)
          .set({ permissionLevel: role, updatedAt: new Date() })
          .where(
            and(
              eq(agentMemberAccess.agentId, agentId),
              eq(agentMemberAccess.memberId, actorId),
            ),
          );
      } else {
        await (db.insert(agentMemberAccess) as any).values({
          agentId,
          memberId: actorId,
          permissionLevel: role,
        });
      }

      return { actorId, role };
    },

    /**
     * Removes access for actorId on agentId. No-op if row doesn't exist.
     *
     * Replaces agent_member_access delete via PostgREST.
     */
    async revokeAgentAccess(agentId: string, actorId: string) {
      await (db.delete(agentMemberAccess) as any).where(
        and(
          eq(agentMemberAccess.agentId, agentId),
          eq(agentMemberAccess.memberId, actorId),
        ),
      );
    },

    /**
     * Lists all access rows for an agent.
     * Items have keys: { actorId, agentActorId, role } plus extra fields.
     *
     * Replaces agent_member_access select via PostgREST.
     */
    async listAgentAccess(agentId: string) {
      const rows = await db
        .select({
          id: agentMemberAccess.id,
          agentId: agentMemberAccess.agentId,
          memberId: agentMemberAccess.memberId,
          permissionLevel: agentMemberAccess.permissionLevel,
          grantedByMemberId: agentMemberAccess.grantedByMemberId,
          createdAt: agentMemberAccess.createdAt,
          updatedAt: agentMemberAccess.updatedAt,
        })
        .from(agentMemberAccess)
        .where(eq(agentMemberAccess.agentId, agentId));

      const items = rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        agentActorId: r.agentId,
        actorId: r.memberId,
        memberId: r.memberId,
        role: r.permissionLevel,
        permissionLevel: r.permissionLevel,
        grantedByMemberId: r.grantedByMemberId ?? null,
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      }));

      return { items };
    },

    /**
     * Returns actor id strings for all members with 'admin' permission on agentId.
     *
     * Replaces list_agent_admin_member_actor_ids RPC.
     */
    async listAgentAdminMembers(agentId: string) {
      const rows = await db
        .select({ memberId: agentMemberAccess.memberId })
        .from(agentMemberAccess)
        .where(
          and(
            eq(agentMemberAccess.agentId, agentId),
            eq(agentMemberAccess.permissionLevel, "admin"),
          ),
        );
      return { items: rows.map((r) => r.memberId as string) };
    },

    /**
     * Sets agent visibility to 'team'. Owner-gated via team-scoped resolution.
     *
     * Replaces share_agent_to_team RPC.
     */
    async shareAgentToTeam(agentId: string) {
      if (ctx.userId) {
        const isOwner = await checkAgentOwnership(db, ctx.userId, agentId);
        if (!isOwner) throw new ApiError(403, "forbidden", "not the agent owner");
      }
      await (db.update(agents) as any)
        .set({ visibility: "team", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    },

    /**
     * Sets agent visibility to 'personal'. Owner-gated via team-scoped resolution.
     *
     * Replaces make_agent_personal RPC.
     */
    async makeAgentPersonal(agentId: string) {
      if (ctx.userId) {
        const isOwner = await checkAgentOwnership(db, ctx.userId, agentId);
        if (!isOwner) throw new ApiError(403, "forbidden", "not the agent owner");
      }
      await (db.update(agents) as any)
        .set({ visibility: "personal", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    },

    /**
     * Returns the device_id for an agent.
     */
    async getAgentDeviceId(agentActorId: string) {
      const rows = await db
        .select({ deviceId: agents.deviceId })
        .from(agents)
        .where(eq(agents.id, agentActorId))
        .limit(1);
      return { deviceId: rows[0]?.deviceId ?? null };
    },

    /**
     * Updates the display_name / visibility of an owned agent.
     * Uses team-scoped owner resolution — not global current_member_id().
     *
     * Replaces update_owned_agent_profile RPC.
     */
    async updateOwnedAgentProfile(
      agentId: string,
      patch: { displayName?: string | null; visibility?: string | null },
    ) {
      // Resolve owner if userId is available; skip authz if ctx is empty (internal calls)
      if (ctx.userId) {
        const callerActorId = await resolveActorForAgent(db, ctx.userId, agentId);
        if (!callerActorId) throw new ApiError(403, "forbidden", "not a member of this team");
        const [ag] = await db
          .select({ ownerMemberId: agents.ownerMemberId })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        if (!ag || ag.ownerMemberId !== callerActorId) {
          throw new ApiError(403, "forbidden", "not the agent owner");
        }
      }

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (patch.displayName !== undefined) {
        // Update the actor row's displayName
        if (patch.displayName !== null) {
          await (db.update(actors) as any)
            .set({ displayName: patch.displayName, updatedAt: new Date() })
            .where(eq(actors.id, agentId));
        }
      }
      if (patch.visibility !== undefined && patch.visibility !== null) {
        updates.visibility = patch.visibility;
      }
      await (db.update(agents) as any).set(updates).where(eq(agents.id, agentId));
    },

    /**
     * Updates the default workspace / agentKind / defaultAgentType for an agent.
     * Owner-gated via team-scoped resolution.
     *
     * Replaces update_agent_defaults RPC.
     */
    async updateAgentDefaults(
      agentId: string,
      patch: {
        defaultWorkspaceId?: string | null;
        agentKind?: string | null;
        defaultAgentType?: string | null;
      },
    ) {
      if (ctx.userId) {
        const isOwner = await checkAgentOwnership(db, ctx.userId, agentId);
        if (!isOwner) throw new ApiError(403, "forbidden", "not the agent owner");
      }

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (patch.defaultWorkspaceId !== undefined) {
        updates.defaultWorkspaceId = patch.defaultWorkspaceId;
      }
      if (patch.agentKind !== undefined && patch.agentKind !== null) {
        updates.agentKind = patch.agentKind;
      }
      if (patch.defaultAgentType !== undefined) {
        updates.defaultAgentType = patch.defaultAgentType;
      }
      await (db.update(agents) as any).set(updates).where(eq(agents.id, agentId));
    },

    /**
     * Ensures the agent's agentTypes / defaultAgentType are set.
     * No-op if already set.
     */
    async ensureAgentTypes({
      supportedTypes,
      defaultAgentType,
    }: {
      supportedTypes: string[];
      defaultAgentType: string;
    }) {
      if (!ctx.callerActorId) {
        throw new ApiError(403, "forbidden", "ensureAgentTypes: no agent actor visible to caller");
      }
      await (db.update(agents) as any)
        .set({ agentTypes: supportedTypes, defaultAgentType, updatedAt: new Date() })
        .where(eq(agents.id, ctx.callerActorId));
    },

    /**
     * Sets the device_id for an agent.
     */
    async setAgentDeviceId(agentActorId: string, opts: { deviceId: string }) {
      await (db.update(agents) as any)
        .set({ deviceId: opts.deviceId, updatedAt: new Date() })
        .where(eq(agents.id, agentActorId));
    },

    /**
     * Returns agentTypes / defaultAgentType for a list of agent ids.
     *
     * Replaces agents select via PostgREST.
     */
    async listAgentDefaults(agentIds: string[]) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const rows = await db
        .select({
          id: agents.id,
          agentTypes: agents.agentTypes,
          defaultAgentType: agents.defaultAgentType,
        })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      return rows.map((r) => ({
        id: r.id,
        agentTypes: Array.isArray(r.agentTypes) ? r.agentTypes : null,
        defaultAgentType: r.defaultAgentType ?? null,
      }));
    },
  };
}
