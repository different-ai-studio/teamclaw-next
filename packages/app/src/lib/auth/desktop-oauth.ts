// Desktop (Tauri) OAuth orchestration: loopback listener + system browser +
// PKCE exchange. Reuses the FC PKCE endpoints via the AuthClient.

import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import type { AuthClient } from "./auth-client";
import { generatePkce } from "./oauth-pkce";
import { AuthError, type Session } from "./types";

export type OAuthProvider = "google" | "wechat";

function friendlyError(raw: unknown): AuthError {
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  if (text.includes("oauth_cancelled") || text.includes("oauth_timeout")) {
    return new AuthError("Sign-in was cancelled.", 0, "oauth_cancelled");
  }
  return new AuthError(text || "OAuth sign-in failed.", 0, "oauth_failed");
}

export async function runDesktopOAuth(
  authClient: AuthClient,
  provider: OAuthProvider,
): Promise<Session> {
  const pkce = await generatePkce();
  const { port } = await invoke<{ port: number }>("oauth_loopback_start");
  const redirect = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = authClient.oauthAuthorizeUrl(provider, redirect, pkce.challenge);
  await shellOpen(authorizeUrl);
  let code: string;
  try {
    ({ code } = await invoke<{ code: string }>("oauth_loopback_await"));
  } catch (err) {
    throw friendlyError(err);
  }
  return authClient.exchangeOAuthCode(code, pkce.verifier);
}
