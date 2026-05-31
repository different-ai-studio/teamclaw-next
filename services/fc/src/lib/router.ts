import {
  getHeader,
  normalizeHeaders,
  parseJsonBody,
} from "./http-utils.js";
import { queryParams } from "./routing-utils.js";

export {
  encodeCursor, decodeCursor, nextSessionCursor, parseLimit,
  queryParams, normalizePath, requireString, optionalStringOrNull,
} from "./routing-utils.js";

export function createRouter({ repository }) {
  const routes = [];

  return {
    get(pattern, optionsOrHandler, handlerMaybe) {
      const [options, handler] = typeof optionsOrHandler === "function"
        ? [{}, optionsOrHandler]
        : [optionsOrHandler, handlerMaybe];
      routes.push({ method: "GET", pattern, handler, auth: options.auth ?? "bearer" });
    },
    post(pattern, optionsOrHandler, handlerMaybe) {
      const [options, handler] = typeof optionsOrHandler === "function"
        ? [{}, optionsOrHandler]
        : [optionsOrHandler, handlerMaybe];
      routes.push({ method: "POST", pattern, handler, auth: options.auth ?? "bearer" });
    },
    put(pattern, optionsOrHandler, handlerMaybe) {
      const [options, handler] = typeof optionsOrHandler === "function"
        ? [{}, optionsOrHandler]
        : [optionsOrHandler, handlerMaybe];
      routes.push({ method: "PUT", pattern, handler, auth: options.auth ?? "bearer" });
    },
    patch(pattern, optionsOrHandler, handlerMaybe) {
      const [options, handler] = typeof optionsOrHandler === "function"
        ? [{}, optionsOrHandler]
        : [optionsOrHandler, handlerMaybe];
      routes.push({ method: "PATCH", pattern, handler, auth: options.auth ?? "bearer" });
    },
    delete(pattern, optionsOrHandler, handlerMaybe) {
      const [options, handler] = typeof optionsOrHandler === "function"
        ? [{}, optionsOrHandler]
        : [optionsOrHandler, handlerMaybe];
      routes.push({ method: "DELETE", pattern, handler, auth: options.auth ?? "bearer" });
    },
    postRaw(pattern, optionsOrHandler, handlerMaybe) {
      const [options, handler] = typeof optionsOrHandler === "function"
        ? [{}, optionsOrHandler]
        : [optionsOrHandler, handlerMaybe];
      routes.push({ method: "POST", pattern, handler, auth: options.auth ?? "bearer", rawBody: true });
    },
    checkRoute({ method, path }) {
      const parts = path.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = matchRoute(route.pattern, parts);
        if (!match) continue;
        return { authRequired: route.auth !== "none" };
      }
      return null;
    },
    async dispatch({ method, path, event }) {
      const parts = path.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = matchRoute(route.pattern, parts);
        if (!match) continue;

        const ctx = buildCtx({ repository, event, parts, params: match.params, rawBody: route.rawBody });
        const result = await route.handler(ctx);
        return { ...result, authRequired: route.auth !== "none" };
      }
      return null;
    },
    async dispatchWithRepository({ method, path, event, repository }) {
      const parts = path.split("/").filter(Boolean);
      for (const route of routes) {
        if (route.method !== method) continue;
        const match = matchRoute(route.pattern, parts);
        if (!match) continue;

        const ctx = buildCtx({ repository, event, parts, params: match.params, rawBody: route.rawBody });
        const result = await route.handler(ctx);
        return result;
      }
      return null;
    },
  };
}

function decodeRawBody(event) {
  if (event.body === undefined || event.body === null || event.body === "") return Buffer.alloc(0);
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64");
  return Buffer.from(event.body, "utf8");
}

function buildCtx({ repository, event, parts, params, rawBody: isRaw }) {
  return {
    repository,
    event,
    parts,
    params,
    query: queryParams(event),
    headers: normalizeHeaders(event.headers),
    json: isRaw ? undefined : parseJsonBody(event),
    rawBody: isRaw ? decodeRawBody(event) : undefined,
    getHeader: (name) => getHeader(event.headers, name),
  };
}

function matchRoute(pattern, parts) {
  const patternParts = pattern.split("/").filter(Boolean);
  if (patternParts.length !== parts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = parts[i];
    } else if (patternParts[i] !== parts[i]) {
      return null;
    }
  }
  return { params };
}
