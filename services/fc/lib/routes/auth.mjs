import { ApiError, extractBearerToken, optionalBearerToken } from "../http-utils.mjs";

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

  router.post("/v1/auth/signin-password", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.email || typeof body.email !== "string") {
      throw new ApiError(400, "validation_failed", "email is required");
    }
    if (!body.password || typeof body.password !== "string") {
      throw new ApiError(400, "validation_failed", "password is required");
    }
    const out = await ctx.repository.signInWithPassword({ email: body.email, password: body.password });
    return { body: out };
  });

  router.post("/v1/auth/signup", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.email || typeof body.email !== "string") {
      throw new ApiError(400, "validation_failed", "email is required");
    }
    if (!body.password || typeof body.password !== "string") {
      throw new ApiError(400, "validation_failed", "password is required");
    }
    const out = await ctx.repository.signUp({ email: body.email, password: body.password });
    return { body: out };
  });

  router.get("/v1/auth/oauth/:provider/authorize", { auth: "none" }, async (ctx) => {
    const provider = decodeURIComponent(ctx.params.provider);
    const redirect = ctx.query.get("redirect");
    const codeChallenge = ctx.query.get("code_challenge");
    if (!redirect) throw new ApiError(400, "validation_failed", "redirect is required");
    if (!codeChallenge) throw new ApiError(400, "validation_failed", "code_challenge is required");
    const location = ctx.repository.oauthAuthorizeUrl({ provider, redirect, codeChallenge });
    return { redirect: location };
  });

  router.post("/v1/auth/oauth/exchange", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.code || typeof body.code !== "string") throw new ApiError(400, "validation_failed", "code is required");
    if (!body.codeVerifier || typeof body.codeVerifier !== "string") throw new ApiError(400, "validation_failed", "codeVerifier is required");
    const out = await ctx.repository.exchangePkceCode({ code: body.code, codeVerifier: body.codeVerifier });
    return { body: out };
  });

  // Native OIDC sign-in (Apple / Google id_token grant). When a bearer token
  // is supplied, GoTrue links the identity to the current user instead of
  // creating a new one — this powers the anonymous → Apple upgrade path.
  router.post("/v1/auth/signin-idtoken", { auth: "none" }, async (ctx) => {
    const body = ctx.json ?? {};
    if (!body.provider || typeof body.provider !== "string") {
      throw new ApiError(400, "validation_failed", "provider is required");
    }
    if (!body.idToken || typeof body.idToken !== "string") {
      throw new ApiError(400, "validation_failed", "idToken is required");
    }
    const accessToken = optionalBearerToken(ctx.event.headers);
    const out = await ctx.repository.signInWithIdToken({
      provider: body.provider,
      idToken: body.idToken,
      nonce: body.nonce ?? null,
      accessToken: accessToken ?? null,
    });
    return { body: out };
  });
}