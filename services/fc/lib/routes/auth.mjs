import { ApiError, extractBearerToken } from "../http-utils.mjs";

export function registerAuth(router) {
  router.post("/v1/auth/refresh", { auth: "none" }, async (ctx) => {
    const { refreshToken } = ctx.json;
    if (!refreshToken || typeof refreshToken !== "string") {
      throw new ApiError(400, "validation_failed", "refreshToken is required");
    }
    const out = await ctx.repository.refreshAccessToken({ refreshToken });
    return { body: out };
  });

  router.post("/v1/auth/signin-anonymous", { auth: "none" }, async (ctx) => {
    const out = await ctx.repository.signInAnonymous();
    return { body: out };
  });

  router.post("/v1/auth/signin-otp", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.email || typeof body.email !== "string") {
      throw new ApiError(400, "validation_failed", "email is required");
    }
    const out = await ctx.repository.signInOtp({ email: body.email, options: body.options });
    return { body: out };
  });

  router.post("/v1/auth/verify-otp", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.email || typeof body.email !== "string") {
      throw new ApiError(400, "validation_failed", "email is required");
    }
    if (!body.token || typeof body.token !== "string") {
      throw new ApiError(400, "validation_failed", "token is required");
    }
    const out = await ctx.repository.verifyOtp({
      email: body.email,
      token: body.token,
      type: body.type ?? "email",
    });
    return { body: out };
  });

  router.post("/v1/auth/signout", { auth: "none" }, async (ctx) => {
    // Authentication is enforced by GoTrue (bearer token is forwarded).
    // We mark as auth:"none" so the FC layer doesn't reject pre-validation;
    // GoTrue itself rejects invalid tokens.
    const accessToken = extractBearerToken(ctx.event.headers);
    if (!accessToken) {
      throw new ApiError(401, "missing_auth", "Bearer token required");
    }
    const out = await ctx.repository.signOut({ accessToken });
    return { body: out };
  });

  router.patch("/v1/auth/user", { auth: "none" }, async (ctx) => {
    const accessToken = extractBearerToken(ctx.event.headers);
    if (!accessToken) {
      throw new ApiError(401, "missing_auth", "Bearer token required");
    }
    const body = ctx.json ?? {};
    const out = await ctx.repository.updateUser({ accessToken, body });
    return { body: out };
  });
}