import type { SupabaseClient } from "@supabase/supabase-js";

export type PushTokenUpload = {
  userId: string;
  deviceId: string;
  /** "ios" | "android" — matches the iOS PushService convention. */
  platform: string;
  /** "apns" today; "fcm" can be enabled after the FC dispatcher supports it. */
  provider: string;
  /** Native push token returned by Expo Notifications / APNs. */
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
      const result = await client.from("device_push_tokens").upsert(
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
      throwIfSupabaseError(result.error);
    },
    async remove(userId, deviceId, provider) {
      const result = await client
        .from("device_push_tokens")
        .delete()
        .eq("user_id", userId)
        .eq("device_id", deviceId)
        .eq("provider", provider);
      throwIfSupabaseError(result.error);
    },
  };
}

function throwIfSupabaseError(error: unknown) {
  if (!error) return;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    throw new Error(typeof message === "string" ? message : "Supabase push token error");
  }
  throw new Error("Supabase push token error");
}
