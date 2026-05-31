import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt, createLocalJWKSet, type JSONWebKeySet } from "jose";
import { buildAuth } from "../src/auth/better-auth.js";
import { createPgAuthRepository } from "../src/lib/pg-repo/auth.js";
import { mintSession } from "../src/auth/mint-session.js";
import { toGoTrueSession } from "../src/auth/reshape.js";
import { verifyAccessToken } from "../src/auth/verify.js";
import { makeTestDb } from "./db/pglite.js";

const BASE = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret-xx";

async function setup() {
  const { db } = await makeTestDb();
  const auth = buildAuth({ db, secret: SECRET, baseURL: BASE });
  const repo = createPgAuthRepository({ auth });
  // The jwt plugin exposes the JWKS via the api; build a local keyset so
  // verifyAccessToken can verify without a running HTTP server.
  const jwks = (await auth.api.getJwks()) as unknown as JSONWebKeySet;
  const keyset = createLocalJWKSet(jwks);
  return { auth, repo, keyset };
}

test("signInAnonymous returns a GoTrue envelope with is_anonymous:true", async () => {
  const { repo } = await setup();
  const env = await repo.signInAnonymous();
  assert.ok(env.access_token, "access_token present");
  assert.ok(env.refresh_token, "refresh_token present (session token)");
  assert.equal(env.token_type, "bearer");
  assert.ok(Number.isInteger(env.expires_at), "expires_at epoch seconds");
  assert.ok(env.user.id, "user.id present");
  assert.equal(env.user.is_anonymous, true);
});

test("signUp + signInWithPassword return GoTrue envelopes carrying the email", async () => {
  const { repo } = await setup();
  const email = "user@example.com";
  const password = "password12345";

  const signedUp = await repo.signUp({ email, password });
  assert.ok(signedUp.access_token);
  assert.equal(signedUp.user.email, email);
  assert.equal(signedUp.user.is_anonymous, false);

  const signedIn = await repo.signInWithPassword({ email, password });
  assert.ok(signedIn.access_token);
  assert.equal(signedIn.user.email, email);
  assert.ok(signedIn.refresh_token, "refresh_token present");
});

test("refreshAccessToken returns camelCase { accessToken, refreshToken, expiresAt:int }", async () => {
  const { repo } = await setup();
  const email = "refresh@example.com";
  const password = "password12345";
  await repo.signUp({ email, password });
  const session = await repo.signInWithPassword({ email, password });

  const refreshed = await repo.refreshAccessToken({ refreshToken: session.refresh_token! });
  assert.ok(refreshed.accessToken, "accessToken present");
  assert.equal(refreshed.refreshToken, session.refresh_token, "refresh token unchanged (no rotation)");
  assert.ok(Number.isInteger(refreshed.expiresAt), "expiresAt integer epoch seconds");
});

test("issued access_token JWT: sub == user id, iss/aud == baseURL, verifyAccessToken agrees", async () => {
  const { repo, keyset } = await setup();
  const env = await repo.signInAnonymous();

  const decoded = decodeJwt(env.access_token);
  assert.equal(decoded.sub, env.user.id, "JWT sub == user id");
  assert.equal(decoded.iss, BASE, "JWT iss == baseURL");
  assert.equal(decoded.aud, BASE, "JWT aud == baseURL");

  // This confirms verify.ts (Task 3) and Better-Auth's minted JWT agree on
  // issuer/audience. verify.ts uses { issuer: baseURL, audience: baseURL } and
  // Better-Auth mints iss=aud=baseURL — so no adjustment to verify.ts needed.
  const claims = await verifyAccessToken(env.access_token, { keyset, baseURL: BASE });
  assert.equal(claims.sub, env.user.id, "verifyAccessToken returns sub == user id");
});

test("email OTP full round trip through the repository -> GoTrue envelope", async () => {
  // Build a dedicated instance whose emailOTP hook captures the code, so we can
  // exercise the real send -> verify flow end to end (no external provider).
  const { db } = await makeTestDb();
  let captured: { otp: string } | null = null;
  // Reuse buildAuth's plugin set but with a capturing OTP delivery: construct
  // via the repository pointed at an instance built with the capturing hook.
  // buildAuth wires sendOtpEmail (a no-op in tests), so instead we drive the
  // api directly to capture, then verify through the repo.
  const { betterAuth } = await import("better-auth");
  const { jwt, bearer, anonymous, emailOTP, genericOAuth } = await import("better-auth/plugins");
  const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
  const schema = await import("../src/db/schema/index.js");
  const auth = betterAuth({
    baseURL: BASE,
    secret: SECRET,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    database: drizzleAdapter(db as any, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt(),
      bearer(),
      anonymous(),
      emailOTP({ sendVerificationOTP: async ({ otp }) => { captured = { otp }; } }),
      genericOAuth({ config: [] }),
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = createPgAuthRepository({ auth: auth as any });

  const email = "otp@example.com";
  const ack = await repo.signInOtp({ email });
  assert.deepEqual(ack, {}, "signInOtp acks with {} after sending");
  assert.ok(captured, "OTP captured by delivery hook");

  const env = await repo.verifyOtp({ email, token: captured!.otp, type: "email" });
  assert.ok(env.access_token, "OTP verify yields access_token");
  assert.equal(env.user.email, email);
  assert.equal(env.token_type, "bearer");
});

test("mintSession creates a session + JWT for an existing user id", async () => {
  const { auth, repo, keyset } = await setup();
  // Create a user via the repo, capture its id.
  const signed = await repo.signUp({ email: "mint@example.com", password: "password12345" });
  const userId = signed.user.id!;

  const minted = await mintSession(userId, auth);
  assert.ok(minted.accessToken, "minted accessToken");
  assert.ok(minted.refreshToken, "minted refreshToken (session token)");
  assert.ok(Number.isInteger(minted.expiresAt), "minted expiresAt integer");

  const decoded = decodeJwt(minted.accessToken);
  assert.equal(decoded.sub, userId, "minted JWT sub == user id");
  const claims = await verifyAccessToken(minted.accessToken, { keyset, baseURL: BASE });
  assert.equal(claims.sub, userId);
});

test("toGoTrueSession reshape (unit) — covers id_token / PKCE paths deferred to deploy verification", () => {
  // id_token (Apple/Google) and PKCE exchange require real external providers,
  // so the FULL round trip is deferred to manual/deploy verification. We assert
  // the reshape contract here against a synthetic Better-Auth-shaped result.
  const env = toGoTrueSession({
    accessToken: "jwt.access.token",
    refreshToken: "session-token",
    expiresAt: 1893456000,
    user: { id: "u-1", email: "oauth@example.com", isAnonymous: false },
  });
  assert.equal(env.access_token, "jwt.access.token");
  assert.equal(env.refresh_token, "session-token");
  assert.equal(env.token_type, "bearer");
  assert.equal(env.expires_at, 1893456000);
  assert.equal(env.user.email, "oauth@example.com");
  assert.equal(env.user.is_anonymous, false);
});
