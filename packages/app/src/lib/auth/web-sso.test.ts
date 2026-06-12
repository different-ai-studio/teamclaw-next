import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/build-config", () => ({
  buildConfig: { features: { auth: { webSSO: true } } },
}));

const cloudApiUrlMock = vi.fn<[], string | undefined>();
vi.mock("@/lib/server-config", () => ({
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: cloudApiUrlMock() }),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { ssoConfig, runWebSso, cancelWebSso } from "@/lib/auth/web-sso";

describe("ssoConfig", () => {
  beforeEach(() => cloudApiUrlMock.mockReset());

  it("maps a non-prod cloudApiUrl to the test admin host", () => {
    cloudApiUrlMock.mockReturnValue("https://belayo-test-api.ucar.cc");
    expect(ssoConfig()).toEqual({
      loginUrl: "https://testadmin.ucar.cc/sign-in",
      host: "testadmin.ucar.cc",
      storageKey: "sb-test-supa-auth-token",
    });
  });

  it("maps the prod cloudApiUrl to the prod admin host", () => {
    cloudApiUrlMock.mockReturnValue("https://cloud.ucar.cc");
    expect(ssoConfig()).toEqual({
      loginUrl: "https://admin.mx5.cn/sign-in",
      host: "admin.mx5.cn",
      storageKey: "sb-supa-auth-token",
    });
  });

  it("returns null when cloudApiUrl is missing", () => {
    cloudApiUrlMock.mockReturnValue(undefined);
    expect(ssoConfig()).toBeNull();
  });
});

describe("runWebSso", () => {
  beforeEach(() => {
    cloudApiUrlMock.mockReturnValue("https://belayo-test-api.ucar.cc");
    invokeMock.mockReset();
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  });

  it("opens the webview, polls localStorage, and returns the refresh_token", async () => {
    const session = JSON.stringify({ access_token: "AT", refresh_token: "RT", user: { id: "u1" } });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "webview_create") return Promise.resolve();
      if (cmd === "webview_close") return Promise.resolve();
      if (cmd === "webview_read_local_storage") return Promise.resolve(session);
      return Promise.resolve(null);
    });
    const rt = await runWebSso({ pollMs: 1, timeoutMs: 1000 });
    expect(rt).toBe("RT");
    expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.objectContaining({
      label: "websso-login",
      url: "https://testadmin.ucar.cc/sign-in",
    }));
    expect(invokeMock).toHaveBeenCalledWith("webview_close", { label: "websso-login" });
  });

  it("keeps polling while localStorage is empty, then resolves", async () => {
    const session = JSON.stringify({ access_token: "AT", refresh_token: "RT", user: { id: "u1" } });
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "webview_read_local_storage") {
        calls += 1;
        return Promise.resolve(calls < 3 ? null : session);
      }
      return Promise.resolve();
    });
    const rt = await runWebSso({ pollMs: 1, timeoutMs: 1000 });
    expect(rt).toBe("RT");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("rejects with websso_cancelled when cancelled", async () => {
    invokeMock.mockResolvedValue(null);
    const p = runWebSso({ pollMs: 5, timeoutMs: 1000 });
    cancelWebSso();
    await expect(p).rejects.toMatchObject({ code: "websso_cancelled" });
    expect(invokeMock).toHaveBeenCalledWith("webview_close", { label: "websso-login" });
  });

  it("rejects with websso_timeout when the deadline passes", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(runWebSso({ pollMs: 1, timeoutMs: 10 })).rejects.toMatchObject({ code: "websso_timeout" });
  });
});
