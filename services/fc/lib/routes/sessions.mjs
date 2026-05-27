import { ApiError } from "../http-utils.mjs";
import { parseLimit, decodeCursor, nextSessionCursor } from "../router.mjs";

export function registerSessions(router) {
  router.get("/v1/sessions", async (ctx) => {
    const limit = parseLimit(ctx.query.get("limit"));
    const cursor = decodeCursor(ctx.query.get("cursor"));
    const items = await ctx.repository.listSessions({ limit, cursor });
    return { body: { items, nextCursor: nextSessionCursor(items, limit) } };
  });
}