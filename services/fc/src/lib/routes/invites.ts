import { requireString } from "../routing-utils.js";

export function registerInvites(router) {
  // Anonymous (no bearer): the daemon's `amuxd init` flow has no token yet.
  // The Supabase RPC `claim_team_invite` enforces invite validity internally
  // via SECURITY DEFINER, so it's safe to call without RLS.
  router.post("/v1/invites/claim", { auth: "none" }, async (ctx) => {
    const body = ctx.json;
    requireString(body.token, "token");
    const result = await ctx.repository.claimInvite(body.token);
    return { body: result };
  });
}