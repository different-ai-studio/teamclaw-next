import { Hono } from "hono";
import { registerAllRoutes } from "./lib/routes/index.js";
import { createHonoRouterAdapter } from "./lib/hono-adapter.js";
import { isRateLimited } from "./lib/rate-limit.js";
import { handleSyncRequest } from "./lib/legacy-sync.js";
import * as admin from "./lib/admin-handlers.js";

export type AppDeps = {
  createRepository: (args: { accessToken: string }) => unknown;
  createAuthRepository: () => unknown;
};

function sendLegacy(_c: any, r: { statusCode: number; headers?: Record<string, string>; body: string }) {
  return new Response(r.body, {
    status: r.statusCode,
    headers: { "Content-Type": "application/json", ...(r.headers || {}) },
  });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // CORS preflight: 204 for all OPTIONS (mirrors index.ts).
  app.options("*", (c) => c.body(null, 204));

  // /v1 business routes — registered through the adapter so routes/*.ts are unchanged.
  const v1Router = createHonoRouterAdapter(app, deps);
  registerAllRoutes(v1Router as any);

  // Rate limit everything that is NOT /v1 (mirrors old index.ts).
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!(url.pathname.startsWith("/v1/") || url.pathname === "/v1")) {
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      const ip = fwd || c.req.header("x-real-ip") || "unknown";
      if (isRateLimited(ip)) return c.json({ error: "Too many requests" }, 429);
    }
    await next();
  });

  // Legacy /sync/* (set-mode, team-mode, manifest, upload/*, download, delete, versions)
  app.all("/sync/*", async (c) => {
    const url = new URL(c.req.url);
    const headers = Object.fromEntries(c.req.raw.headers);
    let body: any = {};
    if (c.req.method === "GET") {
      // The only GET endpoint (/sync/versions) carries its params in the query
      // string; mirror the old syncGetQueryToBody() so teamId/path survive.
      url.searchParams.forEach((v, k) => { body[k] = v; });
    } else {
      const t = await c.req.text();
      body = t ? JSON.parse(t) : {};
    }
    const r = await handleSyncRequest({ path: url.pathname, httpMethod: c.req.method, headers, body });
    return sendLegacy(c, r);
  });

  // Admin/provisioning endpoints (all POST). Each parses JSON body then calls the handler.
  const adminRoutes: Array<[string, (body: any) => Promise<any>]> = [
    ["/register", (b) => admin.handleRegister(b)],
    ["/token", (b) => admin.handleToken(b)],
    ["/reset-secret", (b) => admin.handleResetSecret(b)],
    ["/apply", (b) => admin.handleApply(b)],
    ["/ai/setup-team", (b) => admin.handleAiSetupTeam(b)],
    ["/ai/add-member", (b) => admin.handleAiAddMember(b)],
    ["/ai/remove-member", (b) => admin.handleAiRemoveMember(b)],
    ["/ai/keys", (b) => admin.handleAiKeys(b)],
    ["/ai/usage", (b) => admin.handleAiUsage(b)],
    ["/ai/budget", (b) => admin.handleAiBudget(b)],
    ["/managed-git/create-repo", (b) => admin.handleManagedGitCreateRepo(b)],
    ["/managed-git/setup-litellm", (b) => admin.handleManagedGitSetupLitellm(b)],
  ];
  for (const [path, fn] of adminRoutes) {
    app.post(path, async (c) => {
      const t = await c.req.text();
      let body: any = {};
      if (t) { try { body = JSON.parse(t); } catch { return c.json({ error: "Invalid JSON body" }, 400); } }
      return sendLegacy(c, await fn(body));
    });
  }
  app.post("/push/dispatch", async (c) => {
    const headers = Object.fromEntries(c.req.raw.headers);
    const t = await c.req.text();
    let body: any = {};
    if (t) { try { body = JSON.parse(t); } catch { return c.json({ error: "Invalid JSON body" }, 400); } }
    return sendLegacy(c, await admin.handlePushDispatch(headers, body));
  });

  // Unknown route -> 404 in the existing error envelope.
  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Route not found", requestId: c.req.header("x-request-id") ?? "" } }, 404),
  );

  app.onError((err, c) => {
    console.error("[fc] unhandled:", (err as any)?.message, (err as any)?.name);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
