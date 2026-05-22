import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { createPushTokenApi } from "../features/notifications/push-token-api";

function thenableResult<T>(result: T) {
  const promise = Promise.resolve(result);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

describe("createPushTokenApi", () => {
  it("upserts the native push token with the Supabase row shape", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upsert });
    const api = createPushTokenApi({ from } as unknown as SupabaseClient);

    await api.upload({
      userId: "user-1",
      deviceId: "device-1",
      platform: "ios",
      provider: "apns",
      token: "abcdef",
      appVersion: "0.1.0",
    });

    expect(from).toHaveBeenCalledWith("device_push_tokens");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        device_id: "device-1",
        platform: "ios",
        provider: "apns",
        token: "abcdef",
        app_version: "0.1.0",
      }),
      { onConflict: "user_id,device_id,provider" },
    );
    expect(typeof upsert.mock.calls[0][0].last_seen_at).toBe("string");
  });

  it("throws when Supabase rejects the token upsert", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: "bad token" } });
    const from = vi.fn().mockReturnValue({ upsert });
    const api = createPushTokenApi({ from } as unknown as SupabaseClient);

    await expect(
      api.upload({
        userId: "user-1",
        deviceId: "device-1",
        platform: "ios",
        provider: "apns",
        token: "abcdef",
      }),
    ).rejects.toThrow("bad token");
  });

  it("scopes token removal and surfaces delete errors", async () => {
    const query = {
      eq: vi.fn().mockReturnThis(),
      ...thenableResult({ error: { message: "delete denied" } }),
    };
    const del = vi.fn().mockReturnValue(query);
    const from = vi.fn().mockReturnValue({ delete: del });
    const api = createPushTokenApi({ from } as unknown as SupabaseClient);

    await expect(api.remove("user-1", "device-1", "apns")).rejects.toThrow(
      "delete denied",
    );

    expect(from).toHaveBeenCalledWith("device_push_tokens");
    expect(del).toHaveBeenCalled();
    expect(query.eq).toHaveBeenNthCalledWith(1, "user_id", "user-1");
    expect(query.eq).toHaveBeenNthCalledWith(2, "device_id", "device-1");
    expect(query.eq).toHaveBeenNthCalledWith(3, "provider", "apns");
  });
});
