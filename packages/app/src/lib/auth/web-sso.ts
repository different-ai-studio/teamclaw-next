// Web SSO 快捷登录 — open the Betly admin sign-in page in a native webview, let
// the user sign in there, then harvest the supabase-js session out of that
// page's localStorage and adopt it as the TeamClaw session. The Betly admin
// shares TeamClaw's GoTrue per environment, so its refresh_token is valid
// against TeamClaw's Cloud API. This is the reverse of betly-auth-inject.ts.

import { buildConfig } from "@/lib/build-config";
import { getEffectiveServerConfigSync } from "@/lib/server-config";

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
