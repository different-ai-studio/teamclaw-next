import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSessionStoreForTests,
  configureSessionStore,
  getSession,
  refreshSession,
  setSession,
  subscribe,
} from "../session-store";
import type { Session } from "../types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "atk",
    refresh_token: "rtk",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: "u1", email: "u@example.com" },
    ...overrides,
  };
}

beforeEach(() => {
  __resetSessionStoreForTests();
});

afterEach(() => {
  __resetSessionStoreForTests();
  vi.useRealTimers();
});

describe("session-store", () => {
  it("setSession persists to localStorage and getSession reads it back", () => {
    const s = makeSession();
    setSession(s);
    expect(getSession()).toEqual(s);
    expect(JSON.parse(window.localStorage.getItem("teamclaw.session.v1")!)).toEqual(s);
  });

  it("setSession(null) clears the persisted session", () => {
    setSession(makeSession());
    setSession(null);
    expect(getSession()).toBeNull();
    expect(window.localStorage.getItem("teamclaw.session.v1")).toBeNull();
  });

  it("subscribe receives change events", () => {
    const cb = vi.fn();
    subscribe(cb);
    const s = makeSession();
    setSession(s);
    expect(cb).toHaveBeenCalledWith("SIGNED_IN", s);
    setSession(null);
    expect(cb).toHaveBeenLastCalledWith("SIGNED_OUT", null);
  });

  it("concurrent refresh callers share the same in-flight promise", async () => {
    const refresher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return makeSession({ access_token: "atk2" });
    });
    configureSessionStore({ refresher });
    setSession(makeSession());

    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(getSession()?.access_token).toBe("atk2");
  });

  it("clears session when refresh fails with invalid_grant", async () => {
    const refresher = vi.fn(async () => {
      const err = Object.assign(new Error("invalid grant"), {
        status: 400,
        code: "invalid_grant",
      });
      throw err;
    });
    configureSessionStore({ refresher });
    setSession(makeSession());

    await expect(refreshSession()).rejects.toThrow("invalid grant");
    expect(getSession()).toBeNull();
  });

  it("auto-refresh fires shortly before expires_at", async () => {
    vi.useFakeTimers();
    const next = makeSession({ access_token: "fresh" });
    const refresher = vi.fn(async () => next);

    const expiresAt = Math.floor(Date.now() / 1000) + 120; // 2 min from now
    configureSessionStore({ refresher });
    setSession(makeSession({ expires_at: expiresAt }));

    // 60-second leeway means the timer fires at expires_at - 60s = ~60s from now.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(refresher).toHaveBeenCalledTimes(1);
  });
});
