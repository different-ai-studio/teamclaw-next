import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSupabaseConfig", () => {
  it("returns configured values when EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY are present", async () => {
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");

    const { getSupabaseConfig } = await import("../lib/supabase/config");

    expect(getSupabaseConfig()).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "publishable-key",
    });
  });

  it("throws with message containing 'Missing Expo Supabase configuration' when missing", async () => {
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    const { getSupabaseConfig } = await import("../lib/supabase/config");

    expect(() => getSupabaseConfig()).toThrowError(/Missing Expo Supabase configuration/);
  });
});
