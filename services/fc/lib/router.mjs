import {
  ApiError,
  getHeader,
  parseJsonBody,
} from "./http-utils.mjs";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

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

        const ctx = {
          repository,
          event,
          parts,
          params: match.params,
          query: queryParams(event),
          json: parseJsonBody(event),
          getHeader: (name) => getHeader(event.headers, name),
        };

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

        const ctx = {
          repository,
          event,
          parts,
          params: match.params,
          query: queryParams(event),
          json: parseJsonBody(event),
          getHeader: (name) => getHeader(event.headers, name),
        };

        const result = await route.handler(ctx);
        return result;
      }
      return null;
    },
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

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return {
      lastMessageAt: optionalStringOrNull(parsed.lastMessageAt, "cursor.lastMessageAt"),
      createdAt: optionalStringOrNull(parsed.createdAt, "cursor.createdAt"),
      id: optionalStringOrNull(parsed.id, "cursor.id"),
    };
  } catch (cause) {
    throw new ApiError(400, "validation_failed", "Invalid cursor", { cause });
  }
}

export function nextSessionCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({
    lastMessageAt: last.lastMessageAt ?? null,
    createdAt: last.createdAt ?? null,
    id: last.id,
  });
}

export function parseLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 100");
  }
  return limit;
}

export function queryParams(event) {
  const direct = event.queryStringParameters || {};
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(direct)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  if (event.rawQueryString) {
    for (const [key, value] of new URLSearchParams(event.rawQueryString)) {
      params.set(key, value);
    }
  }
  return params;
}

export function normalizePath(path) {
  const withoutQuery = path.split("?")[0];
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

export function requireString(value, field) {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new ApiError(400, "validation_failed", `${field} is required`);
}

export function optionalStringOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new ApiError(400, "validation_failed", `${field} must be a string or null`);
}