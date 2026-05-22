import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { createPresenceApi } from "../features/notifications/presence-api";

describe("createPresenceApi", () => {
  it("upserts the foreground lease for the authenticated user/device", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upsert });
    const api = createPresenceApi({ from } as unknown as SupabaseClient, () => "user-1");

    await api.writeForeground("device-1", new Date("2026-05-22T08:00:45.000Z"));

    expect(from).toHaveBeenCalledWith("client_presence");
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: "user-1",
        device_id: "device-1",
        foreground_until: "2026-05-22T08:00:45.000Z",
      },
      { onConflict: "user_id,device_id" },
    );
  });

  it("does nothing when there is no signed-in user", async () => {
    const upsert = vi.fn();
    const from = vi.fn().mockReturnValue({ upsert });
    const api = createPresenceApi({ from } as unknown as SupabaseClient, () => null);

    await api.writeForeground("device-1", new Date("2026-05-22T08:00:45.000Z"));

    expect(from).not.toHaveBeenCalled();
  });

  it("throws Supabase write errors", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: "rls denied" } });
    const from = vi.fn().mockReturnValue({ upsert });
    const api = createPresenceApi({ from } as unknown as SupabaseClient, () => "user-1");

    await expect(
      api.writeForeground("device-1", new Date("2026-05-22T08:00:45.000Z")),
    ).rejects.toThrow("rls denied");
  });
});
