import { ApiError } from "../http-utils.mjs";

export function registerAuth(router) {
  router.post("/v1/auth/refresh", { auth: "none" }, async (ctx) => {
    const { refreshToken } = ctx.json;
    if (!refreshToken || typeof refreshToken !== "string") {
      throw new ApiError(400, "validation_failed", "refreshToken is required");
    }
    const out = await ctx.repository.refreshAccessToken({ refreshToken });
    return { body: out };
  });
}