import { describe, it, expect, vi } from "vitest";
import { reportDesktopClientVersion } from "../report-client-version";

describe("reportDesktopClientVersion", () => {
  it("POSTs clientType tauri with version + deviceId", async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    await reportDesktopClientVersion({ post } as any, "team-1", { version: "0.1.82", deviceId: "mac-1" });
    expect(post).toHaveBeenCalledWith("/v1/teams/team-1/client-version", {
      clientType: "tauri",
      version: "0.1.82",
      deviceId: "mac-1",
      build: null,
    });
  });

  it("never throws when post rejects", async () => {
    const post = vi.fn().mockRejectedValue(new Error("network"));
    await expect(
      reportDesktopClientVersion({ post } as any, "team-1", { version: "x", deviceId: "d" }),
    ).resolves.toBeUndefined();
  });
});
