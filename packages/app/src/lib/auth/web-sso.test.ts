import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/build-config", () => ({
  buildConfig: { features: { auth: { webSSO: true } } },
}));

const cloudApiUrlMock = vi.fn<[], string | undefined>();
vi.mock("@/lib/server-config", () => ({
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: cloudApiUrlMock() }),
}));

import { ssoConfig } from "@/lib/auth/web-sso";

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
