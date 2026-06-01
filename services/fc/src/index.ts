import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
export { resolveBackendKind } from "./lib/backend-kind.js";
import { resolveBackendKind } from "./lib/backend-kind.js";
import { runCronTask } from "./lib/cron.js";
import {
  createSupabaseAuthRepository,
  createSupabaseBusinessRepository,
  publishableKeyFromEnv,
} from "./lib/supabase-repo.js";
import { getDb } from "./db/client.js";
import { createPgBusinessRepository } from "./lib/pg-repo/index.js";
import { createPgAuthRepository } from "./lib/pg-repo/auth.js";
import { queryParams } from "./lib/routing-utils.js";
import { dispatchPush } from "./lib/push-dispatch.js";
import { pushDeps, pgPushDeps } from "./lib/admin-handlers.js";
import { verifyAccessToken } from "./auth/verify.js";
import { ApiError } from "./lib/http-utils.js";
import type { JWTVerifyGetKey } from "jose";

// ---------------------------------------------------------------------------
// Environment (used only for /v1 business API). Read lazily inside the deps
// closures so importing this module never requires env at load time.
// ---------------------------------------------------------------------------
const SUPABASE_URL_FN = () => process.env.SUPABASE_URL || "";
const SUPABASE_PUBLISHABLE_KEY = () => publishableKeyFromEnv(process.env);

// Build a body-like object from a GET event's query string (used by the only
// GET endpoint on the legacy /sync/* API, /sync/versions). Delegates to
// queryParams() so it reads event.queryStringParameters / event.queryParameters
// — the fields the FC HTTP trigger actually populates — with rawQueryString /
// rawPath fallbacks. Reading rawQueryString alone drops teamId & path and 400s
// the request ("teamId is required").
//
// Retained as an exported pure helper because sync-versions-query.test.ts pins
// its query-parsing contract. The /sync GET path itself is now handled inside
// createApp (which mirrors this same parsing).
export function syncGetQueryToBody(event: any) {
  const body: Record<string, string> = {};
  for (const [k, v] of queryParams(event)) body[k] = v;
  return body;
}

export function makeAuthRepoFactory(kind: "supabase" | "postgres") {
  if (kind === "postgres") {
    return () => createPgAuthRepository();
  }
  return () =>
    createSupabaseAuthRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      publishableKey: SUPABASE_PUBLISHABLE_KEY(),
    });
}

export function makeBusinessRepoFactory(
  kind: "supabase" | "postgres",
  // Tests may inject a local JWKS + issuer/audience baseURL so verifyAccessToken
  // can validate tokens signed by an in-memory key. Production omits this and
  // uses the remote JWKS at AUTH_BASE_URL.
  verifyOpts?: { keyset?: JWTVerifyGetKey; baseURL?: string },
) {
  if (kind === "postgres") {
    // ROOT-CAUSE FIX: verify the bearer JWT and resolve the authenticated
    // user id (claims.sub) BEFORE constructing the repo, so every authz check
    // gated on ctx.userId actually has an identity. A bad/expired token makes
    // verifyAccessToken reject; the hono adapter's try/catch maps it to 401.
    return async ({ accessToken }: { accessToken: string }) => {
      let claims;
      try {
        claims = await verifyAccessToken(accessToken, verifyOpts ?? {});
      } catch (cause) {
        // Bad / expired / unverifiable token → fail closed as 401 (not an opaque
        // 500). errorResponse passes ApiError through verbatim.
        throw new ApiError(401, "invalid_token", "Invalid or expired access token", { cause });
      }
      return createPgBusinessRepository({
        db: getDb(),
        userId: claims.sub,
        accessToken,
        // Lazy push hook: pgPushDeps() is constructed on first call and reused.
        // push_idempotency_claim and list_session_push_targets are now served
        // by Drizzle queries via buildPgPushDeps() — no Supabase service-role.
        dispatchPush: async (record) => { await dispatchPush(record, pgPushDeps()); },
      });
    };
  }
  return ({ accessToken }: { accessToken: string }) =>
    createSupabaseBusinessRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      publishableKey: SUPABASE_PUBLISHABLE_KEY(),
      accessToken,
    });
}

// The single Hono app owns ALL routing (OPTIONS, /v1, /sync, admin, 404, 500,
// rate-limiting). The repository deps build lazily per-request.
const app = createApp({
  createRepository: makeBusinessRepoFactory(resolveBackendKind()),
  createAuthRepository: makeAuthRepoFactory(resolveBackendKind()),
});

const honoHandler = handle(app);

// FC 3.0 HTTP trigger may populate queryParameters (or queryStringParameters)
// but leave rawQueryString empty/absent. hono/aws-lambda's v2 processor (used
// when event.rawPath exists) reads ONLY rawQueryString for the query string —
// it does NOT fall back to structured params. Backfill rawQueryString via
// queryParams() so GET query params (e.g. /v1/sync/actor-directory?teamId=…)
// are not silently dropped.
export function normalizeFcEvent(event: any): any {
  if (!event.rawQueryString || event.rawQueryString === "") {
    const s = queryParams(event).toString();
    if (s) event.rawQueryString = s;
  }
  return event;
}

// ---------------------------------------------------------------------------
// Timer-event detection
//
// Aliyun FC timer events carry triggerName / triggerTime and a custom payload
// string, but do NOT have rawPath / requestContext (those are HTTP-only).
// We use the absence of rawPath + requestContext as the definitive signal.
// ---------------------------------------------------------------------------
function isTimerEvent(event: any): boolean {
  if (event == null || typeof event !== "object") return false;
  // HTTP events always have rawPath (FC 3.0) or requestContext (FC 2.0/3.0).
  if (event.rawPath != null || event.requestContext != null) return false;
  // Timer events have either triggerName or triggerTime, plus a payload field.
  return (event.triggerName != null || event.triggerTime != null) && event.payload != null;
}

export async function handler(event: any, context: any) {
  // FC 3.0 HTTP trigger passes a Buffer; FC 2.0 may pass a JSON string.
  if (Buffer.isBuffer(event)) {
    event = JSON.parse(event.toString());
  } else if (typeof event === "string") {
    event = JSON.parse(event);
  }

  // Route timer events to cron handlers before the Hono app sees them.
  if (isTimerEvent(event)) {
    let payload: { task?: string };
    try {
      payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    } catch {
      return { error: "invalid_payload", message: "Timer payload is not valid JSON" };
    }
    if (!payload.task) {
      return { error: "missing_task", message: "Timer payload must include a task field" };
    }
    return runCronTask(getDb(), payload.task);
  }

  normalizeFcEvent(event);
  return honoHandler(event, context);
}
