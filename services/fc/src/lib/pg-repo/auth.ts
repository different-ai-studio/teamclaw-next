import { getAuth, type Auth } from "../../auth/better-auth.js";
import { mintSession } from "../../auth/mint-session.js";
import { toGoTrueSession, toRefreshShape, toEpochSeconds } from "../../auth/reshape.js";

// createPgAuthRepository — the BACKEND_KIND=postgres AuthRepository, backed by
// Better-Auth. Every method calls the VERIFIED getAuth().api.* and reshapes the
// result into the fixed client contract (GoTrue-compatible envelopes).
//
// VERIFIED Better-Auth (1.6.12) facts driving the reshaping:
//   - signInAnonymous / signInEmail / signUpEmail / signInEmailOTP return
//     `{ token: <sessionToken>, user }`. That `token` is the SESSION token, NOT
//     a JWT. We treat it as the refresh_token.
//   - The client-facing access_token must be a JWT. We obtain it via the jwt
//     plugin: auth.api.getToken({ headers: Authorization: Bearer <sessionToken> })
//     -> `{ token: <JWT> }`. The JWT has sub=userId, iss=aud=baseURL (matches
//     verify.ts), exp ~15m.
//   - Session (refresh) expiry comes from auth.api.getSession(...).session.expiresAt.
export function createPgAuthRepository(opts: { auth?: Auth } = {}) {
  // Keep getAuth() lazy — resolve inside each method so importing the module
  // needs no env. `opts.auth` lets tests inject a pglite-backed instance.
  const resolveAuth = () => opts.auth ?? getAuth();

  function bearer(sessionToken: string): Headers {
    const h = new Headers();
    h.set("authorization", `Bearer ${sessionToken}`);
    return h;
  }

  // Mint a JWT access_token from a Better-Auth session token via the jwt plugin.
  async function jwtFor(auth: Auth, sessionToken: string): Promise<string> {
    const out = await auth.api.getToken({ headers: bearer(sessionToken) });
    if (!out?.token) throw new Error("auth_jwt_unavailable");
    return out.token;
  }

  // Read the session row (for refresh expiry) using the session token.
  async function sessionExpiry(auth: Auth, sessionToken: string): Promise<number | null> {
    const s = await auth.api.getSession({ headers: bearer(sessionToken) });
    return toEpochSeconds(s?.session?.expiresAt);
  }

  // Turn a Better-Auth sign-in result ({ token, user }) into the GoTrue envelope:
  // access_token = freshly minted JWT, refresh_token = the session token.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function envelopeFromSignIn(auth: Auth, result: any) {
    const sessionToken: string | undefined = result?.token;
    const user = result?.user;
    if (!sessionToken || !user) throw new Error("auth_signin_no_session");
    const accessToken = await jwtFor(auth, sessionToken);
    const expiresAt = await sessionExpiry(auth, sessionToken);
    return toGoTrueSession({ accessToken, refreshToken: sessionToken, expiresAt, user });
  }

  return {
    // --- Anonymous ---
    async signInAnonymous() {
      const auth = resolveAuth();
      const result = await auth.api.signInAnonymous();
      return envelopeFromSignIn(auth, result);
    },

    // --- Email + password ---
    async signUp({ email, password }: { email: string; password: string }) {
      const auth = resolveAuth();
      const result = await auth.api.signUpEmail({ body: { email, password, name: email } });
      return envelopeFromSignIn(auth, result);
    },

    async signInWithPassword({ email, password }: { email: string; password: string }) {
      const auth = resolveAuth();
      const result = await auth.api.signInEmail({ body: { email, password } });
      return envelopeFromSignIn(auth, result);
    },

    // --- Email OTP ---
    async signInOtp({ email, options }: { email: string; options?: unknown }) {
      void options; // GoTrue accepts options (e.g. shouldCreateUser); Better-Auth always creates.
      const auth = resolveAuth();
      // Better-Auth: send a sign-in OTP. Returns { success: true }; clients
      // expect a GoTrue-ish empty-ish ack after sending.
      await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
      return {};
    },

    async verifyOtp({ email, token }: { email: string; token: string; type?: string }) {
      const auth = resolveAuth();
      const result = await auth.api.signInEmailOTP({ body: { email, otp: token } });
      return envelopeFromSignIn(auth, result);
    },

    // --- Refresh ---
    // The incoming refreshToken is the Better-Auth session token. Validate it
    // (getSession) and re-mint a JWT. Better-Auth does not rotate the session
    // token on JWT fetch, so refreshToken is returned unchanged.
    async refreshAccessToken({ refreshToken }: { refreshToken: string }) {
      const auth = resolveAuth();
      const session = await auth.api.getSession({ headers: bearer(refreshToken) });
      if (!session?.session) throw new Error("invalid_refresh_token");
      const accessToken = await jwtFor(auth, refreshToken);
      const expiresAt = toEpochSeconds(session.session.expiresAt);
      if (expiresAt == null) throw new Error("invalid_refresh_token");
      return toRefreshShape({ accessToken, refreshToken, expiresAt });
    },

    // --- Native OIDC (Apple / Google id_token grant) ---
    // Better-Auth signInSocial with an idToken body performs the native grant.
    // When accessToken (a JWT) is supplied, the caller is upgrading the current
    // (anonymous) user; Better-Auth links by passing the session in headers.
    async signInWithIdToken({
      provider,
      idToken,
      nonce,
      accessToken,
    }: {
      provider: string;
      idToken: string;
      nonce?: string | null;
      accessToken?: string | null;
    }) {
      const auth = resolveAuth();
      const headers = new Headers();
      if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
      const result = await auth.api.signInSocial({
        body: {
          provider,
          idToken: { token: idToken, ...(nonce ? { nonce } : {}) },
        },
        headers,
      });
      return envelopeFromSignIn(auth, result);
    },

    // --- OAuth PKCE (web redirect flow) ---
    // Synchronous: returns the upstream authorize URL the caller 302-redirects to.
    oauthAuthorizeUrl({
      provider,
      redirect,
      codeChallenge,
    }: {
      provider: string;
      redirect: string;
      codeChallenge: string;
    }): string {
      const auth = resolveAuth();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const baseURL = ((auth as any).options?.baseURL ?? process.env.AUTH_BASE_URL ?? "https://cloud.ucar.cc") as string;
      const u = new URL(`${baseURL}/api/auth/sign-in/social`);
      u.searchParams.set("provider", provider);
      u.searchParams.set("callbackURL", redirect);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },

    async exchangePkceCode({ code, codeVerifier }: { code: string; codeVerifier: string }) {
      const auth = resolveAuth();
      // Better-Auth completes the OAuth2 callback; the JS API surface for the
      // PKCE exchange is the oAuth2Callback endpoint. Reshape into the envelope.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (auth.api as any).callbackOAuth({
        body: { code, codeVerifier },
      });
      return envelopeFromSignIn(auth, result);
    },

    // --- Pass-through-ish ---
    async signOut({ accessToken }: { accessToken: string }) {
      const auth = resolveAuth();
      const out = await auth.api.signOut({ headers: bearer(accessToken) });
      return out ?? { success: true };
    },

    async updateUser({ accessToken, body }: { accessToken: string; body: Record<string, unknown> }) {
      const auth = resolveAuth();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await auth.api.updateUser({ headers: bearer(accessToken), body: body as any });
      return out ?? { status: true };
    },

    // --- Plan 5 ---
    async claimInvite(_token: string) {
      void _token;
      throw new Error("not_implemented:claimInvite");
    },

    // Re-exported primitive for Plan 5 wiring.
    mintSession: (userId: string) => mintSession(userId, resolveAuth()),
  };
}
