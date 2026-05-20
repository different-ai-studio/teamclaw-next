import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-user, per-session mute toggle. Mirrors the iOS `session_mutes` table
 * (`user_id`, `session_id` composite key) so the FC notification fan-out
 * skips push delivery when a session is muted.
 */
export type SessionMutesApi = {
  isMuted: (sessionId: string) => Promise<boolean>;
  setMuted: (sessionId: string, muted: boolean) => Promise<void>;
};

export function createSessionMutesApi(
  client: SupabaseClient,
  userId: () => string | null,
): SessionMutesApi {
  return {
    async isMuted(sessionId) {
      const uid = userId();
      if (!uid || !sessionId) return false;
      const result = await client
        .from("session_mutes")
        .select("session_id")
        .eq("user_id", uid)
        .eq("session_id", sessionId)
        .limit(1);
      const rows = result.data;
      return Array.isArray(rows) && rows.length > 0;
    },
    async setMuted(sessionId, muted) {
      const uid = userId();
      if (!uid || !sessionId) return;
      if (muted) {
        await client
          .from("session_mutes")
          .upsert(
            { user_id: uid, session_id: sessionId },
            { onConflict: "user_id,session_id" },
          );
      } else {
        await client
          .from("session_mutes")
          .delete()
          .eq("user_id", uid)
          .eq("session_id", sessionId);
      }
    },
  };
}
