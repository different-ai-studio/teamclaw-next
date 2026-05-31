import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import {
  createSupabaseAuthRepository,
  createSupabaseBusinessRepository,
  publishableKeyFromEnv,
} from "./lib/supabase-repo.js";
import { getDb } from "./db/client.js";
import { createPgBusinessRepository } from "./lib/pg-repo/index.js";
import { queryParams } from "./lib/routing-utils.js";

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

// ---------------------------------------------------------------------------
// Backend kind selection — defaults to "supabase"; set BACKEND_KIND=postgres
// to use the direct-postgres repo (Plan 5+).
// ---------------------------------------------------------------------------
export function resolveBackendKind(env: NodeJS.ProcessEnv = process.env): "supabase" | "postgres" {
  return env.BACKEND_KIND === "postgres" ? "postgres" : "supabase";
}

export function makeBusinessRepoFactory(kind: "supabase" | "postgres") {
  if (kind === "postgres") {
    return ({ accessToken }: { accessToken: string }) =>
      createPgBusinessRepository({ db: getDb(), accessToken });
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
  createAuthRepository: () =>
    createSupabaseAuthRepository({
      supabaseUrl: SUPABASE_URL_FN(),
      publishableKey: SUPABASE_PUBLISHABLE_KEY(),
    }),
});

const honoHandler = handle(app);

// FC 3.0 HTTP trigger may populate queryStringParameters but leave rawQueryString
// empty/absent. hono/aws-lambda's v2 processor (used when event.rawPath exists)
// reads ONLY rawQueryString for the query string — it does NOT fall back to
// queryStringParameters. Backfill rawQueryString from queryStringParameters when
// rawQueryString is missing so GET query params are not silently dropped.
export function normalizeFcEvent(event: any): any {
  if (
    (!event.rawQueryString || event.rawQueryString === "") &&
    event.queryStringParameters &&
    typeof event.queryStringParameters === "object"
  ) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) event.rawQueryString = s;
  }
  return event;
}

export async function handler(event: any, context: any) {
  // FC 3.0 HTTP trigger passes a Buffer; FC 2.0 may pass a JSON string.
  if (Buffer.isBuffer(event)) {
    event = JSON.parse(event.toString());
  } else if (typeof event === "string") {
    event = JSON.parse(event);
  }
  normalizeFcEvent(event);
  return honoHandler(event, context);
}
