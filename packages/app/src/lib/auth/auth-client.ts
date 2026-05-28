// Thin HTTP client for TeamClaw's FC auth proxy endpoints (/v1/auth/*).
// Returns / consumes the raw GoTrue session shape.

import { AuthError, type OtpType, type Session } from "./types";
import {
  configureSessionStore,
  getSession,
  refreshSession,
  setSession,
} from "./session-store";

export interface AuthClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export type AuthClient = {
  signInAnonymously(): Promise<Session>;
  sendOtp(email: string, options?: Record<string, unknown>): Promise<void>;
  verifyOtp(email: string, token: string, type?: OtpType): Promise<Session>;
  signOut(): Promise<void>;
  updateUser(attrs: Record<string, unknown>): Promise<{ user?: unknown } | null>;
  refresh(): Promise<Session>;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

async function parseJsonOrThrow(res: Response, op: string): Promise<unknown> {
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const message =
      error?.message ||
      (typeof (data as { msg?: string } | null)?.msg === "string"
        ? (data as { msg?: string }).msg!
        : null) ||
      `${op} failed (${res.status})`;
    const code = error?.code || (data as { error?: string } | null)?.error || "auth_error";
    throw new AuthError(message, res.status, String(code));
  }
  return data;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createAuthClient(opts: AuthClientOptions): AuthClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = (path: string) => joinUrl(opts.baseUrl, path);

  async function post(path: string, body: unknown, bearer?: string | null) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetchImpl(url(path), {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parseJsonOrThrow(res, path);
  }

  async function patch(path: string, body: unknown, bearer?: string | null) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetchImpl(url(path), {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return parseJsonOrThrow(res, path);
  }

  function currentToken(): string | null {
    return getSession()?.access_token ?? null;
  }

  async function refresh(): Promise<Session> {
    const session = getSession();
    if (!session?.refresh_token) {
      throw new AuthError("No refresh token available.", 401, "no_refresh_token");
    }
    const data = (await post("/v1/auth/refresh", { refreshToken: session.refresh_token })) as Session;
    return data;
  }

  // Wire the refresher into the SessionStore so timer-driven refreshes work.
  configureSessionStore({
    refresher: async (refreshToken: string) => {
      const data = (await post("/v1/auth/refresh", { refreshToken })) as Session;
      return data;
    },
  });

  return {
    async signInAnonymously(): Promise<Session> {
      const data = (await post("/v1/auth/signin-anonymous", {})) as Session;
      setSession(data, "SIGNED_IN");
      return data;
    },
    async sendOtp(email, options) {
      await post("/v1/auth/signin-otp", { email, options });
    },
    async verifyOtp(email, token, type = "email"): Promise<Session> {
      const data = (await post("/v1/auth/verify-otp", { email, token, type })) as Session;
      setSession(data, "SIGNED_IN");
      return data;
    },
    async signOut() {
      const bearer = currentToken();
      try {
        if (bearer) await post("/v1/auth/signout", {}, bearer);
      } catch (err) {
        // Network or 401 is fine — user is being signed out locally regardless.
        console.warn("[auth] signOut request failed; clearing local session anyway", err);
      } finally {
        setSession(null, "SIGNED_OUT");
      }
    },
    async updateUser(attrs) {
      const bearer = currentToken();
      if (!bearer) throw new AuthError("Not authenticated.", 401, "no_session");
      const data = (await patch("/v1/auth/user", attrs, bearer)) as
        | { user?: unknown; session?: Session }
        | null;
      // GoTrue updateUser may return either a user or a session; merge if a
      // session shape is present.
      if (data && typeof data === "object" && "access_token" in data) {
        setSession(data as Session, "USER_UPDATED");
      } else if (data && typeof data === "object" && "user" in data) {
        const cur = getSession();
        if (cur && data.user && typeof data.user === "object") {
          setSession({ ...cur, user: { ...cur.user, ...(data.user as Record<string, unknown>) } } as Session, "USER_UPDATED");
        }
      }
      return data;
    },
    refresh,
  };
}

export { refreshSession };
