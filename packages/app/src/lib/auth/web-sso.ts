// Web SSO 快捷登录 — open the Betly admin sign-in page in a native webview, let
// the user sign in there, then harvest the supabase-js session out of that
// page's localStorage and adopt it as the TeamClaw session. The Betly admin
// shares TeamClaw's GoTrue per environment, so its refresh_token is valid
// against TeamClaw's Cloud API. This is the reverse of betly-auth-inject.ts.

import { buildConfig } from "@/lib/build-config";
import { getEffectiveServerConfigSync } from "@/lib/server-config";
import { invoke } from "@tauri-apps/api/core";
import { AuthError } from "@/lib/auth/types";

export interface SsoConfig {
  /** Full sign-in URL to load in the webview. */
  loginUrl: string;
  /** Admin host (also the injection allowlist host). */
  host: string;
  /** supabase-js localStorage key to read the session from. */
  storageKey: string;
}

// env → admin host + supabase-js storage key. Mirrors PR #477's host→key map.
const PROD: SsoConfig = {
  loginUrl: "https://admin.mx5.cn/sign-in",
  host: "admin.mx5.cn",
  storageKey: "sb-supa-auth-token",
};
const TEST: SsoConfig = {
  loginUrl: "https://testadmin.ucar.cc/sign-in",
  host: "testadmin.ucar.cc",
  storageKey: "sb-test-supa-auth-token",
};

/**
 * Resolve the SSO target for the current build/environment, or null when the
 * feature is off or the environment can't be determined. Prod == cloud.ucar.cc;
 * any other cloudApiUrl is treated as the test environment.
 */
export function ssoConfig(): SsoConfig | null {
  if (!buildConfig.features.auth?.webSSO) return null;
  const cloudApiUrl = getEffectiveServerConfigSync().cloudApiUrl;
  if (!cloudApiUrl) return null;
  let host: string;
  try {
    host = new URL(cloudApiUrl).host;
  } catch {
    return null;
  }
  return host === "cloud.ucar.cc" ? PROD : TEST;
}

// ---------------------------------------------------------------------------
// runWebSso — modal webview polling orchestration
// ---------------------------------------------------------------------------

const WEBSSO_LABEL = "websso-login";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 180_000;
const PANEL_W = 480;
const PANEL_H = 640;

let activeController: AbortController | null = null;

interface RunWebSsoOptions {
  pollMs?: number;
  timeoutMs?: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AuthError("Sign-in was cancelled.", 0, "websso_cancelled"));
    }, { once: true });
  });
}

/**
 * Open the Betly admin sign-in page in a centered modal webview, harvest the
 * supabase session from its localStorage once the user signs in, and return the
 * harvested refresh_token. Closes the webview on every exit path. Throws
 * AuthError with code websso_cancelled | websso_timeout | websso_failed.
 */
export async function runWebSso(opts: RunWebSsoOptions = {}): Promise<string> {
  const cfg = ssoConfig();
  if (!cfg) throw new AuthError("Web SSO is not available.", 0, "websso_failed");

  const controller = new AbortController();
  activeController = controller;
  const { signal } = controller;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const x = Math.max(0, Math.round((window.innerWidth - PANEL_W) / 2));
  const y = Math.max(0, Math.round((window.innerHeight - PANEL_H) / 2));

  try {
    await invoke("webview_create", {
      label: WEBSSO_LABEL,
      url: cfg.loginUrl,
      x, y, width: PANEL_W, height: PANEL_H,
      // Force a fresh login: clear any stale Betly session lingering in the
      // shared webview store, whose refresh token may already be consumed.
      clearStorageKey: cfg.storageKey,
    });

    for (;;) {
      if (signal.aborted) throw new AuthError("Sign-in was cancelled.", 0, "websso_cancelled");
      if (Date.now() >= deadline) throw new AuthError("Sign-in timed out.", 0, "websso_timeout");

      const raw = await invoke<string | null>("webview_read_local_storage", {
        label: WEBSSO_LABEL,
        key: cfg.storageKey,
      });
      const refreshToken = raw ? parseRefreshToken(raw) : null;
      if (refreshToken) return refreshToken;

      await delay(pollMs, signal);
    }
  } finally {
    activeController = null;
    await invoke("webview_close", { label: WEBSSO_LABEL }).catch(() => {});
  }
}

/** Abort an in-flight runWebSso (closes the webview via its finally block). */
export function cancelWebSso(): void {
  activeController?.abort();
}

function parseRefreshToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string" && parsed.refresh_token) {
      return parsed.refresh_token;
    }
  } catch {
    // not yet a complete session — keep polling
  }
  return null;
}
