import { Hono } from "hono";
import { registerAllRoutes } from "./lib/routes/index.js";
import { createHonoRouterAdapter } from "./lib/hono-adapter.js";

export type AppDeps = {
  createRepository: (args: { accessToken: string }) => unknown;
  createAuthRepository: () => unknown;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // CORS preflight: 204 for all OPTIONS (mirrors index.ts).
  app.options("*", (c) => c.body(null, 204));

  // /v1 business routes — registered through the adapter so routes/*.ts are unchanged.
  const v1Router = createHonoRouterAdapter(app, deps);
  registerAllRoutes(v1Router as any);

  // Unknown route -> 404 in the existing error envelope.
  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Route not found", requestId: c.req.header("x-request-id") ?? "" } }, 404),
  );

  return app;
}
