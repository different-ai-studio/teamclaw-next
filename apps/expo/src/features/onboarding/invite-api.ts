import type { SupabaseClient } from "@supabase/supabase-js";

export type InviteClaimResult = {
  actorId: string;
  teamId: string;
  actorType: string;
  displayName: string;
  refreshToken: string | null;
};

export type InviteApi = {
  claim: (token: string) => Promise<InviteClaimResult>;
};

/**
 * Calls Postgres RPC `claim_team_invite` to redeem an invite token. Returns
 * the same shape iOS reads in `SupabaseActorRepository.claimInvite`. Mirrors
 * iOS so the onboarding coordinator can interoperate with the same backend.
 */
export function createInviteApi(client: SupabaseClient): InviteApi {
  return {
    async claim(token) {
      const trimmed = token.trim();
      if (!trimmed) {
        throw new Error("Invite token is empty.");
      }
      const result = await client.rpc("claim_team_invite", { token: trimmed });
      if (result.error) {
        throw new Error(result.error.message ?? "Couldn't claim invite.");
      }
      const rows = Array.isArray(result.data) ? result.data : [result.data];
      const row = rows[0] as
        | {
            actor_id?: string;
            team_id?: string;
            actor_type?: string;
            display_name?: string;
            refresh_token?: string | null;
          }
        | null
        | undefined;
      if (!row?.actor_id || !row?.team_id) {
        throw new Error("Invite claim returned no actor/team — token may be expired.");
      }
      return {
        actorId: row.actor_id,
        teamId: row.team_id,
        actorType: row.actor_type ?? "member",
        displayName: row.display_name ?? "",
        refreshToken: row.refresh_token ?? null,
      };
    },
  };
}

/**
 * Pulls the invite token out of a `teamclaw://invite/...` or
 * `teamclaw://invite?token=...` deep link. Returns null when the URL is for
 * something other than invites or has no parseable token.
 *
 * Tolerates the two shapes the iOS app emits (path token + query token) so
 * shared links continue to work across platforms.
 */
export function parseInviteToken(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // RN's URL parser puts the scheme in `protocol` with the trailing colon,
  // e.g. "teamclaw:". The host is what comes right after `//`.
  const isInvite =
    (parsed.protocol === "teamclaw:" && parsed.host === "invite") ||
    parsed.pathname.startsWith("/invite");
  if (!isInvite) return null;

  const queryToken = parsed.searchParams.get("token");
  if (queryToken && queryToken.length > 0) return queryToken;

  // Path forms: "teamclaw://invite/<token>" → host="invite", pathname="/<token>"
  // or "/invite/<token>" → pathname="/invite/<token>".
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] === "invite" && segments[1]) return segments[1];
  if (segments[0]) return segments[0];
  return null;
}
