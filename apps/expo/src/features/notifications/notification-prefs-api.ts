import type { SupabaseClient } from "@supabase/supabase-js";

export type NotificationPrefs = {
  enabled: boolean;
  dndStartMin: number | null;
  dndEndMin: number | null;
  dndTz: string;
};

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  dndStartMin: null,
  dndEndMin: null,
  dndTz: "Asia/Shanghai",
};

export type NotificationPrefsApi = {
  load: () => Promise<NotificationPrefs>;
  save: (prefs: NotificationPrefs) => Promise<void>;
};

export function createNotificationPrefsApi(
  client: SupabaseClient,
  userId: () => string | null,
): NotificationPrefsApi {
  return {
    async load() {
      const uid = userId();
      if (!uid) return { ...DEFAULT_PREFS };
      const result = await client
        .from("notification_prefs")
        .select("enabled, dnd_start_min, dnd_end_min, dnd_tz")
        .eq("user_id", uid)
        .maybeSingle();
      const row = result.data as
        | {
            enabled: boolean;
            dnd_start_min: number | null;
            dnd_end_min: number | null;
            dnd_tz: string | null;
          }
        | null;
      if (!row) return { ...DEFAULT_PREFS };
      return {
        enabled: row.enabled,
        dndStartMin: row.dnd_start_min,
        dndEndMin: row.dnd_end_min,
        dndTz: row.dnd_tz ?? DEFAULT_PREFS.dndTz,
      };
    },
    async save(prefs) {
      const uid = userId();
      if (!uid) return;
      await client
        .from("notification_prefs")
        .upsert(
          {
            user_id: uid,
            enabled: prefs.enabled,
            dnd_start_min: prefs.dndStartMin,
            dnd_end_min: prefs.dndEndMin,
            dnd_tz: prefs.dndTz,
          },
          { onConflict: "user_id" },
        );
    },
  };
}

export { DEFAULT_PREFS as defaultNotificationPrefs };
