/**
 * Notifications + Presence domain — pg-repo implementation.
 *
 * Caller identity:
 *  - getNotificationPrefs / putNotificationPrefs: keyed by user_id (UUID).
 *    Resolved from ctx.userId (set via accessToken/userId at factory time).
 *  - muteSession / unmuteSession / listMutedSessions: keyed by user_id on
 *    session_mutes (the schema uses user_id, not actor_id).
 *  - registerDevicePushToken: keyed by user_id + device_id + provider.
 *  - writeForegroundPresence: keyed by user_id + device_id.
 *
 * Default shapes for getNotificationPrefs (when no row exists):
 *   { userId: null, pushEnabled: true, emailEnabled: false, digestFrequency: "off" }
 */

import { eq, and } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  notificationPrefs,
  devicePushTokens,
  sessionMutes,
  clientPresence,
} from "../../db/schema/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface NotificationsCtx {
  userId?: string;
}

export function makeNotificationsRepo(db: DbLike, ctx: NotificationsCtx = {}) {
  function requireUserId(explicit?: string | null): string {
    const id = explicit ?? ctx.userId;
    if (!id) throw new Error("notifications: userId required but not provided");
    return id;
  }

  return {
    // ── getNotificationPrefs ────────────────────────────────────────────────
    async getNotificationPrefs() {
      const userId = ctx.userId ?? null;
      if (!userId) {
        return {
          userId: null,
          pushEnabled: true,
          emailEnabled: false,
          digestFrequency: "off" as const,
        };
      }
      const rows = await db
        .select()
        .from(notificationPrefs)
        .where(eq(notificationPrefs.userId, userId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return {
          userId,
          pushEnabled: true,
          emailEnabled: false,
          digestFrequency: "off" as const,
        };
      }
      return mapNotificationPrefs(row);
    },

    // ── putNotificationPrefs ────────────────────────────────────────────────
    async putNotificationPrefs(input: {
      userId?: string | null;
      pushEnabled?: boolean;
      emailEnabled?: boolean;
      digestFrequency?: string;
    }) {
      const userId = requireUserId(input.userId);
      const pushEnabled = input.pushEnabled ?? true;
      const emailEnabled = input.emailEnabled ?? false;
      const digestFrequency = input.digestFrequency ?? "off";

      // Persist only the real schema columns: enabled (= pushEnabled).
      // emailEnabled and digestFrequency have no columns in the real schema —
      // they are accepted from the caller and echoed back as defaults only.
      // dnd_tz is reserved for its real purpose (DnD timezone string).
      await (db.insert(notificationPrefs) as any)
        .values({
          userId,
          enabled: pushEnabled,
        })
        .onConflictDoUpdate({
          target: notificationPrefs.userId,
          set: {
            enabled: pushEnabled,
            updatedAt: new Date(),
          },
        });
      // Echo back the full input shape (emailEnabled/digestFrequency are not
      // persisted but are returned to satisfy the contract's echo semantics).
      return { userId, pushEnabled, emailEnabled, digestFrequency };
    },

    // ── muteSession ─────────────────────────────────────────────────────────
    async muteSession(sessionId: string, input: { until?: string | null }) {
      const userId = requireUserId();
      await (db.insert(sessionMutes) as any)
        .values({ userId, sessionId })
        .onConflictDoUpdate({
          target: [sessionMutes.userId, sessionMutes.sessionId],
          set: { mutedAt: new Date() },
        });
      void input; // until not in current schema; accepted but not persisted
    },

    // ── unmuteSession ───────────────────────────────────────────────────────
    async unmuteSession(sessionId: string) {
      const userId = requireUserId();
      await db
        .delete(sessionMutes)
        .where(
          and(
            eq(sessionMutes.userId, userId),
            eq(sessionMutes.sessionId, sessionId)
          )
        );
    },

    // ── listMutedSessions ───────────────────────────────────────────────────
    async listMutedSessions() {
      const userId = requireUserId();
      const rows = await db
        .select({ sessionId: sessionMutes.sessionId })
        .from(sessionMutes)
        .where(eq(sessionMutes.userId, userId));
      return { items: rows.map((r) => r.sessionId) };
    },

    // ── registerDevicePushToken ─────────────────────────────────────────────
    async registerDevicePushToken(input: {
      deviceId: string;
      platform?: string;
      provider?: string;
      token: string;
      appVersion?: string | null;
    }) {
      const userId = requireUserId();
      const now = new Date();
      await (db.insert(devicePushTokens) as any)
        .values({
          userId,
          deviceId: input.deviceId,
          platform: input.platform ?? "ios",
          provider: input.provider ?? "apns",
          token: input.token,
          appVersion: input.appVersion ?? null,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [devicePushTokens.userId, devicePushTokens.deviceId, devicePushTokens.provider],
          set: {
            token: input.token,
            platform: input.platform ?? "ios",
            appVersion: input.appVersion ?? null,
            lastSeenAt: now,
          },
        });
    },

    // ── writeForegroundPresence ─────────────────────────────────────────────
    async writeForegroundPresence(input: { deviceId: string; foregroundUntil: string }) {
      const userId = requireUserId();
      await (db.insert(clientPresence) as any)
        .values({
          userId,
          deviceId: input.deviceId,
          foregroundUntil: new Date(input.foregroundUntil),
        })
        .onConflictDoUpdate({
          target: [clientPresence.userId, clientPresence.deviceId],
          set: {
            foregroundUntil: new Date(input.foregroundUntil),
          },
        });
    },
  };
}

function mapNotificationPrefs(row: {
  userId: string;
  enabled: boolean;
}) {
  // emailEnabled and digestFrequency are not stored in the real schema.
  // Return non-persisted defaults alongside the real persisted columns.
  return {
    userId: row.userId,
    pushEnabled: row.enabled,
    emailEnabled: false,
    digestFrequency: "off" as const,
  };
}
