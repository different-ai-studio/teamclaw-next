import { eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { getAuth, type Auth } from "../../auth/better-auth.js";
import { mintSession } from "../../auth/mint-session.js";
import { toGoTrueSession, toRefreshShape, toEpochSeconds } from "../../auth/reshape.js";
import { teamInvites, actors, members, teamMembers, agents, agentMemberAccess } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { randomUUID } from "node:crypto";

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
export function createPgAuthRepository(opts: { auth?: Auth; db?: PgDatabase<any, any> } = {}) {
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
    // claimInvite(token, { userId? }):
    //   member branch: requires a userId (existing Better-Auth user); inserts
    //     actor(member) + member(active) + team_member; refreshToken = null.
    //   agent branch: creates a daemon Better-Auth user (daemon.{uuid}@amuxd.run),
    //     inserts actor(agent) + agents + agent_member_access(admin); mints a
    //     session and returns the refreshToken.
    //   Both branches mark the invite consumed atomically in a transaction.
    async claimInvite(token: string, ctx: { userId?: string } = {}) {
      const db = opts.db;
      if (!db) throw new Error("claimInvite requires db to be passed in opts");
      const auth = resolveAuth();

      // Load + validate invite
      const [invite] = await db
        .select()
        .from(teamInvites)
        .where(eq(teamInvites.token, token))
        .limit(1);
      if (!invite) throw new ApiError(404, "not_found", "invite not found");
      if (invite.consumedAt) throw new ApiError(409, "conflict", "invite_already_claimed");
      if (new Date(invite.expiresAt) < new Date()) throw new ApiError(404, "not_found", "invite_expired");

      const kind = invite.kind; // "member" | "agent"

      if (kind === "member") {
        const userId = ctx.userId;
        if (!userId) throw new ApiError(400, "bad_request", "userId required for member invite claim");

        return await (db as any).transaction(async (tx: any) => {
          // Insert actor
          const [actor] = await tx.insert(actors).values({
            teamId: invite.teamId,
            actorType: "member",
            displayName: invite.displayName,
            userId,
            invitedByActorId: invite.invitedByActorId,
          }).returning();

          // Insert member (active)
          await tx.insert(members).values({ id: actor.id, status: "active" });

          // Insert team_member
          await tx.insert(teamMembers).values({
            teamId: invite.teamId,
            memberId: actor.id,
            role: invite.teamRole ?? "member",
          });

          // Mark invite consumed
          await (tx.update(teamInvites) as any)
            .set({ consumedAt: new Date(), consumedByActorId: actor.id })
            .where(eq(teamInvites.token, token));

          return {
            actorId: actor.id,
            teamId: invite.teamId,
            actorType: "member" as const,
            displayName: invite.displayName,
            refreshToken: null,
          };
        });
      }

      if (kind === "agent") {
        // Create a daemon Better-Auth user via internalAdapter.createUser
        // (same surface used by mintSession for createSession)
        const ctx2 = await (auth as any).$context;
        const daemonEmail = `daemon.${randomUUID()}@amuxd.run`;
        const daemonUser = await ctx2.internalAdapter.createUser({
          email: daemonEmail,
          name: invite.displayName,
          emailVerified: false,
        });
        if (!daemonUser?.id) throw new Error("failed to create daemon Better-Auth user");

        const minted = await mintSession(daemonUser.id, auth);

        return await (db as any).transaction(async (tx: any) => {
          // Insert actor (agent type, userId = daemon BA user)
          const [actor] = await tx.insert(actors).values({
            teamId: invite.teamId,
            actorType: "agent",
            displayName: invite.displayName,
            userId: daemonUser.id,
            invitedByActorId: invite.invitedByActorId,
          }).returning();

          // Insert agents row
          await tx.insert(agents).values({
            id: actor.id,
            agentKind: invite.agentKind ?? "daemon",
            status: "active",
            visibility: "team",
          });

          // Insert agent_member_access: grant admin to invitedByActorId
          // (invitedByActorId is a member actor; use it as the memberId)
          await tx.insert(agentMemberAccess).values({
            agentId: actor.id,
            memberId: invite.invitedByActorId,
            permissionLevel: "admin",
            grantedByMemberId: invite.invitedByActorId,
          });

          // Mark invite consumed
          await (tx.update(teamInvites) as any)
            .set({ consumedAt: new Date(), consumedByActorId: actor.id })
            .where(eq(teamInvites.token, token));

          return {
            actorId: actor.id,
            teamId: invite.teamId,
            actorType: "agent" as const,
            displayName: invite.displayName,
            refreshToken: minted.refreshToken,
          };
        });
      }

      throw new ApiError(400, "bad_request", `unsupported invite kind: ${kind}`);
    },

    // Re-exported primitive for Plan 5 wiring.
    mintSession: (userId: string) => mintSession(userId, resolveAuth()),
  };
}
