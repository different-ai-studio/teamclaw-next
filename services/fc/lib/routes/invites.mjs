import { requireString } from "../router.mjs";

export function registerInvites(router) {
  router.post("/v1/invites/claim", async (ctx) => {
    const body = ctx.json;
    requireString(body.token, "token");
    const result = await ctx.repository.claimInvite(body.token);
    return { body: result };
  });
}