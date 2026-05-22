import type { SupabaseClient } from "@supabase/supabase-js";

export type PresenceApi = {
  writeForeground: (deviceId: string, until: Date) => Promise<void>;
};

export function createPresenceApi(
  client: SupabaseClient,
  userId: () => string | null,
): PresenceApi {
  return {
    async writeForeground(deviceId, until) {
      const uid = userId();
      if (!uid) return;
      const result = await client.from("client_presence").upsert(
        {
          user_id: uid,
          device_id: deviceId,
          foreground_until: until.toISOString(),
        },
        { onConflict: "user_id,device_id" },
      );
      throwIfSupabaseError(result.error);
    },
  };
}

function throwIfSupabaseError(error: unknown) {
  if (!error) return;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    throw new Error(typeof message === "string" ? message : "Supabase presence error");
  }
  throw new Error("Supabase presence error");
}
