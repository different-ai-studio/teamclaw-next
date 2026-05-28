import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "../auth-client";
import {
  __resetSessionStoreForTests,
  getSession,
  setSession,
} from "../session-store";
import type { Session } from "../types";

const BASE = "https://fc.test";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "atk",
    refresh_token: "rtk",
    user: { id: "u1" },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  __resetSessionStoreForTests();
});

afterEach(() => {
  __resetSessionStoreForTests();
});

describe("auth-client", () => {
  it("signInAnonymously POSTs and stores the session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, makeSession({ access_token: "anon" })));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    const next = await client.signInAnonymously();
    expect(next.access_token).toBe("anon");
    expect(getSession()?.access_token).toBe("anon");
    const call = fetchImpl.mock.calls[0];
    expect(call[0]).toBe(`${BASE}/v1/auth/signin-anonymous`);
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("sendOtp POSTs email + options without storing a session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.sendOtp("u@example.com", { shouldCreateUser: true });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      email: "u@example.com",
      options: { shouldCreateUser: true },
    });
    expect(getSession()).toBeNull();
  });

  it("verifyOtp stores the returned session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, makeSession({ access_token: "verified" })));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.verifyOtp("u@example.com", "123456");
    expect(getSession()?.access_token).toBe("verified");
  });

  it("signOut clears local session even if the request fails", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: { message: "expired" } }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    setSession(makeSession());
    await client.signOut();
    expect(getSession()).toBeNull();
  });

  it("updateUser forwards body verbatim with bearer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { user: { id: "u1", email: "new@example.com" } }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    setSession(makeSession());
    await client.updateUser({ email: "new@example.com" });
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).method).toBe("PATCH");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer atk");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: "new@example.com" });
  });

  it("non-2xx responses raise AuthError with the GoTrue message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { code: "validation_failed", message: "bad" } }));
    const client = createAuthClient({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.signInAnonymously()).rejects.toMatchObject({
      name: "AuthError",
      status: 400,
      code: "validation_failed",
      message: "bad",
    });
  });
});
