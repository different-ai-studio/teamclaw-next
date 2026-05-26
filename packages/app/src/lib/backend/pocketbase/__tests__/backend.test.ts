import type { ServerConfig } from "@/lib/server-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPocketBaseBackend } from "../index";

describe("PocketBase backend preview auth", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs in with seeded preview credentials and persists the session", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8090/api/collections/accounts/auth-with-password");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        identity: "preview+member@teamclaw.local",
        password: "teamclaw-preview",
      });
      return new Response(
        JSON.stringify({
          token: "header.payload.signature",
          record: {
            id: "account-1",
            email: "preview+member@teamclaw.local",
            display_name: "Preview User",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = createPocketBaseBackend({
      pocketbaseUrl: "http://127.0.0.1:8090/",
    } satisfies ServerConfig);
    const seen: Array<string | null> = [];
    const unsubscribe = backend.auth.onAuthStateChange((session) => seen.push(session?.user.id ?? null));

    const session = await backend.auth.signInAnonymously();

    expect(session?.user).toMatchObject({
      id: "account-1",
      email: "preview+member@teamclaw.local",
    });
    await expect(backend.auth.getSession()).resolves.toMatchObject({
      user: { id: "account-1" },
      accessToken: "header.payload.signature",
    });
    expect(seen).toEqual(["account-1"]);

    await backend.auth.signOut();

    await expect(backend.auth.getSession()).resolves.toBeNull();
    expect(seen).toEqual(["account-1", null]);
    unsubscribe();
  });
});
