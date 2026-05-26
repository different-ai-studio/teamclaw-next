import type { NotificationsBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";

type QueryResult<T = unknown> = Promise<{ data: T; error: unknown | null }>;

type SupabaseNotificationsClient = {
  from(table: string): {
    select(columns: string): unknown;
    upsert(row: Record<string, unknown>, options?: { onConflict?: string }): Promise<{ error: unknown | null }>;
    delete(): { eq(column: string, value: unknown): unknown };
  };
};

export function createSupabaseNotificationsBackend(client: unknown = defaultSupabase): NotificationsBackend {
  const supabase = client as SupabaseNotificationsClient;

  return {
    async loadPreferences(userId) {
      const query = supabase.from("notification_prefs").select("*") as {
        eq(column: string, value: unknown): { maybeSingle(): QueryResult<Record<string, unknown> | null> };
      };
      const { data, error } = await query.eq("user_id", userId).maybeSingle();
      if (error) throw toBackendError(error, "notifications.loadPreferences");
      return data as Awaited<ReturnType<NotificationsBackend["loadPreferences"]>>;
    },
    async savePreferences(input) {
      const row: Record<string, unknown> = {
        ...input,
        updated_at: input.updated_at ?? new Date().toISOString(),
      };
      const { error } = await supabase.from("notification_prefs").upsert(row, { onConflict: "user_id" });
      if (error) throw toBackendError(error, "notifications.savePreferences");
    },
    async setSessionMuted(input) {
      if (input.muted) {
        const row = {
          session_id: input.sessionId,
          user_id: input.userId,
        };
        const { error } = await supabase.from("session_mutes").upsert(row, { onConflict: "user_id,session_id" });
        if (error) throw toBackendError(error, "notifications.setSessionMuted");
        return;
      }

      const query = supabase.from("session_mutes").delete().eq("session_id", input.sessionId) as {
        eq(column: string, value: unknown): Promise<{ error: unknown | null }>;
      };
      const { error } = await query.eq("user_id", input.userId);
      if (error) throw toBackendError(error, "notifications.setSessionMuted");
    },
    async listMutedSessionIds(userId) {
      const query = supabase.from("session_mutes").select("session_id") as {
        eq(column: string, value: unknown): QueryResult<Array<{ session_id: string }>>;
      };
      const { data, error } = await query.eq("user_id", userId);
      if (error) throw toBackendError(error, "notifications.listMutedSessionIds");
      return (data ?? []).map((row) => row.session_id).filter(Boolean);
    },
  };
}
