import type { Context, Hono } from "hono";
import {
  ApiError,
  errorResponse,
  extractBearerToken,
  normalizeHeaders,
  parseJsonBody,
  resolveRequestId,
} from "./http-utils.js";

type Deps = {
  createRepository: (args: { accessToken: string }) => unknown;
  createAuthRepository: () => unknown;
};
type RouteOptions = { auth?: "bearer" | "none"; rawBody?: boolean };
type LegacyCtx = Record<string, unknown>;
type LegacyHandler = (ctx: LegacyCtx) => Promise<any> | any;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function synthEvent(c: Context, bodyText: string): any {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k] = v; });
  const url = new URL(c.req.url);
  const queryStringParameters: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryStringParameters[k] = v; });
  return {
    headers,
    body: bodyText,
    isBase64Encoded: false,
    httpMethod: c.req.method,
    path: url.pathname,
    rawPath: url.pathname,
    rawQueryString: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    queryStringParameters,
  };
}

async function buildCtxFromHono(c: Context, repository: unknown, opts: RouteOptions): Promise<LegacyCtx> {
  const isRaw = opts.rawBody === true;
  const rawBuf = isRaw ? Buffer.from(await c.req.arrayBuffer()) : undefined;
  const bodyText = isRaw ? "" : await c.req.text();
  const event = synthEvent(c, bodyText);
  const headers = normalizeHeaders(event.headers);
  const query = new URLSearchParams();
  const url = new URL(c.req.url);
  url.searchParams.forEach((v, k) => query.set(k, v));
  return {
    repository,
    event,
    parts: url.pathname.split("/").filter(Boolean),
    params: c.req.param() as Record<string, string>,
    query,
    headers,
    json: isRaw ? undefined : parseJsonBody(event),
    rawBody: rawBuf,
    getHeader: (name: string) => headers[name.toLowerCase()],
  };
}

function toResponse(c: Context, result: any, requestId: string): Response {
  if (result?.binary) {
    return new Response(result.binary.bytes, {
      status: result.statusCode ?? 200,
      headers: { "Content-Type": result.binary.mime, "X-Request-Id": requestId },
    });
  }
  if (result?.redirect) {
    return new Response("", {
      status: 302,
      headers: { Location: result.redirect, "X-Request-Id": requestId },
    });
  }
  return new Response(JSON.stringify(result?.body), {
    status: result?.statusCode ?? 200,
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
  });
}

function errorToResponse(err: unknown, requestId: string): Response {
  const r = errorResponse(err, requestId);
  return new Response(r.body, { status: r.statusCode, headers: r.headers });
}

export function createHonoRouterAdapter(app: Hono, deps: Deps) {
  function register(method: Method, pattern: string, optionsOrHandler: RouteOptions | LegacyHandler, handlerMaybe?: LegacyHandler) {
    const [options, handler]: [RouteOptions, LegacyHandler] =
      typeof optionsOrHandler === "function" ? [{}, optionsOrHandler] : [optionsOrHandler, handlerMaybe as LegacyHandler];
    const auth = options.auth ?? "bearer";
    const fn = async (c: Context) => {
      const requestId = resolveRequestId(Object.fromEntries(c.req.raw.headers));
      try {
        let repository: unknown;
        if (auth !== "none") {
          const token = extractBearerToken(Object.fromEntries(c.req.raw.headers));
          repository = deps.createRepository({ accessToken: token });
        } else {
          repository = deps.createAuthRepository();
        }
        const ctx = await buildCtxFromHono(c, repository, options);
        const result = await handler(ctx);
        return toResponse(c, result, requestId);
      } catch (err) {
        return errorToResponse(err, requestId);
      }
    };
    const verb = method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    app[verb](pattern, fn);
  }

  return {
    get: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("GET", p, o, h),
    post: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("POST", p, o, h),
    put: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("PUT", p, o, h),
    patch: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("PATCH", p, o, h),
    delete: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) => register("DELETE", p, o, h),
    postRaw: (p: string, o: RouteOptions | LegacyHandler, h?: LegacyHandler) =>
      register("POST", p, typeof o === "function" ? { rawBody: true } : { ...o, rawBody: true }, h),
  };
}

export { ApiError };
