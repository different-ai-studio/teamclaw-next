import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createApnsJwtCache } from './lib/apns-jwt.js';
import { createApnsClient, createHttp2Transport } from './lib/apns.js';
import { createMqttPublisher } from './lib/mqtt-client.js';
import { handleBusinessApiRequest } from './lib/business-api.js';
import {
  createSupabaseAuthRepository,
  createSupabaseBusinessRepository,
  publishableKeyFromEnv,
} from './lib/supabase-repo.js';
import { queryParams } from './lib/router.js';
import { isRateLimited } from './lib/rate-limit.js';
import {
  json,
  handleRegister,
  handleToken,
  handleResetSecret,
  handleApply,
  handleAiSetupTeam,
  handleAiAddMember,
  handleAiRemoveMember,
  handleAiKeys,
  handleAiUsage,
  handleAiBudget,
  handleManagedGitCreateRepo,
  handleManagedGitSetupLitellm,
  handlePushDispatch,
} from './lib/admin-handlers.js';
import { handleSyncRequest } from './lib/legacy-sync.js';

// ---------------------------------------------------------------------------
// Environment (used only for /v1 business API)
// ---------------------------------------------------------------------------
const SUPABASE_URL_FN       = () => process.env.SUPABASE_URL || '';
const SUPABASE_PUBLISHABLE_KEY = () => publishableKeyFromEnv(process.env);

// ---------------------------------------------------------------------------
// FC HTTP handler
// ---------------------------------------------------------------------------

// Build a body-like object from a GET event's query string (used by the only
// GET endpoint on the legacy /sync/* API, /sync/versions). Delegates to
// queryParams() so it reads event.queryStringParameters / event.queryParameters
// — the fields the FC HTTP trigger actually populates — with rawQueryString /
// rawPath fallbacks. Reading rawQueryString alone drops teamId & path and 400s
// the request ("teamId is required").
export function syncGetQueryToBody(event: any) {
  const body: Record<string, string> = {};
  for (const [k, v] of queryParams(event)) body[k] = v;
  return body;
}

export async function handler(event: any, context: any) {
  // FC 3.0 HTTP trigger passes a Buffer, parse it first
  if (Buffer.isBuffer(event)) {
    event = JSON.parse(event.toString());
  } else if (typeof event === "string") {
    event = JSON.parse(event);
  }
  // Support both FC 2.0 and FC 3.0 event formats
  const path = event.rawPath || event.path;
  const httpMethod =
    event.requestContext?.http?.method || event.httpMethod;
  const rawBody = event.body;
  const headers = event.headers;

  // Handle CORS preflight FIRST so rate limits never break CORS.
  if (httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: {}, body: "" };
  }

  // Rate limiting only applies to the legacy /sync* sync API; the /v1/ business
  // API is called by the regular frontend and would be choked by the 10/min
  // limit (which exists to throttle abusive sync clients, not normal use).
  if (!(path?.startsWith("/v1/") || path === "/v1")) {
    const ip =
      headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      headers?.["x-real-ip"] ||
      "unknown";
    if (isRateLimited(ip)) {
      return json(429, { error: "Too many requests" });
    }
  }

  if (path?.startsWith("/v1/") || path === "/v1") {
    return handleBusinessApiRequest(event, {
      createRepository({ accessToken }: { accessToken: string }) {
        return createSupabaseBusinessRepository({
          supabaseUrl: SUPABASE_URL_FN(),
          publishableKey: SUPABASE_PUBLISHABLE_KEY(),
          accessToken,
        });
      },
      createAuthRepository() {
        return createSupabaseAuthRepository({
          supabaseUrl: SUPABASE_URL_FN(),
          publishableKey: SUPABASE_PUBLISHABLE_KEY(),
        });
      },
    });
  }

  // GET is allowed only for /sync/versions; all others must be POST.
  if (httpMethod !== "POST" && !(httpMethod === "GET" && path === "/sync/versions")) {
    return json(405, { error: "Method not allowed" });
  }

  let body: any;
  if (httpMethod === "GET") {
    // Parse the query string into a body-like object for /sync/versions.
    body = syncGetQueryToBody(event);
  } else {
    try {
      body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody || {};
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }
  }

  try {
    // ---------------------------------------------------------------------------
    // /sync/* routes — JWT auth required for all
    // ---------------------------------------------------------------------------
    // NOTE: /sync/create-team was removed in 2026-05; team creation now goes
    // through POST /v1/teams (which provisions LiteLLM + seeds
    // team_workspace_config in a single call).

    if (path?.startsWith("/sync/")) {
      return await handleSyncRequest({ path, httpMethod, headers, body });
    }

    switch (path) {
      case "/register":
        return await handleRegister(body);
      case "/token":
        return await handleToken(body);
      case "/reset-secret":
        return await handleResetSecret(body);
      case "/apply":
        return await handleApply(body);
      case "/ai/setup-team":
        return await handleAiSetupTeam(body);
      case "/ai/add-member":
        return await handleAiAddMember(body);
      case "/ai/remove-member":
        return await handleAiRemoveMember(body);
      case "/ai/keys":
        return await handleAiKeys(body);
      case "/ai/usage":
        return await handleAiUsage(body);
      case "/ai/budget":
        return await handleAiBudget(body);
      case "/managed-git/create-repo":
        return await handleManagedGitCreateRepo(body);
      case "/managed-git/setup-litellm":
        return await handleManagedGitSetupLitellm(body);
      case "/push/dispatch":
        return await handlePushDispatch(headers, body);
      default:
        return json(404, { error: "Not found" });
    }
  } catch (err: any) {
    console.error(`[error] ${path}:`, err.message, err.name, err.Code, err.$metadata);
    return json(500, { error: "Internal server error" });
  }
}
