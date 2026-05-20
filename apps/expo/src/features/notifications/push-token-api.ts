import type { SupabaseClient } from "@supabase/supabase-js";

export type PushTokenUpload = {
  userId: string;
  deviceId: string;
  /** "ios" | "android" — matches the iOS PushService convention. */
  platform: string;
  /** "expo" | "apns" | "fcm" — the upstream provider that will deliver. */
  provider: string;
  /** Hex string for APNS, ExponentPushToken[...] for Expo, FCM token otherwise. */
  token: string;
  appVersion?: string | null;
};

export type PushTokenApi = {
  upload: (input: PushTokenUpload) => Promise<void>;
  remove: (userId: string, deviceId: string, provider: string) => Promise<void>;
};

/**
 * Mirrors `apps/ios/.../SupabasePushAdapters.swift`: writes into
 * `device_push_tokens` with the same column shape. The Supabase RLS
 * policy keys on `user_id`, so callers must pass the auth user ID, not
 * a member actor ID.
 */
export function createPushTokenApi(client: SupabaseClient): PushTokenApi {
  return {
    async upload(input) {
      await client.from("device_push_tokens").upsert(
        {
          user_id: input.userId,
          device_id: input.deviceId,
          platform: input.platform,
          provider: input.provider,
          token: input.token,
          app_version: input.appVersion ?? null,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "user_id,device_id,provider" },
      );
    },
    async remove(userId, deviceId, provider) {
      await client
        .from("device_push_tokens")
        .delete()
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .eq("provider", provider);
    },
  };
}
