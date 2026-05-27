import {
  ApiError,
  errorResponse,
  extractBearerToken,
  getHeader,
  jsonResponse,
  parseJsonBody,
  resolveRequestId,
} from "./http-utils.mjs";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export async function handleBusinessApiRequest(event, deps) {
  const requestId = resolveRequestId(event.headers);
  try {
    const method = event.httpMethod || event.requestContext?.http?.method || "GET";
    const path = normalizePath(event.path || event.rawPath || "/");
    const token = extractBearerToken(event.headers);
    const repository = deps.createRepository({ accessToken: token });
    const result = await routeBusinessRequest({ method, path, event, repository });
    return jsonResponse(result.statusCode ?? 200, result.body, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function routeBusinessRequest({ method, path, event, repository }) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "v1") throw new ApiError(404, "not_found", "Route not found");

  if (method === "GET" && parts.length === 2 && parts[1] === "teams") {
    const items = await repository.listTeams({ limit: DEFAULT_LIST_LIMIT });
    return { body: { items, nextCursor: null } };
  }

  if (method === "POST" && parts.length === 2 && parts[1] === "teams") {
    const body = parseJsonBody(event);
    requireString(body.name, "name");
    const team = await repository.createTeam({
      name: body.name,
      slug: optionalStringOrNull(body.slug, "slug"),
    });
    return { body: team };
  }

  if (method === "GET" && parts.length === 3 && parts[1] === "teams") {
    const team = await repository.getTeam(decodeURIComponent(parts[2]));
    return { body: team };
  }

  if (method === "GET" && parts.length === 2 && parts[1] === "sessions") {
    const query = queryParams(event);
    const limit = parseLimit(query.get("limit"));
    const cursor = decodeCursor(query.get("cursor"));
    const items = await repository.listSessions({ limit, cursor });
    return { body: { items, nextCursor: nextSessionCursor(items, limit) } };
  }

  if (
    method === "GET" &&
    parts.length === 4 &&
    parts[1] === "sessions" &&
    parts[3] === "messages"
  ) {
    const items = await repository.listMessages(decodeURIComponent(parts[2]));
    return { body: { items, nextCursor: null } };
  }

  if (
    method === "POST" &&
    parts.length === 4 &&
    parts[1] === "sessions" &&
    parts[3] === "messages"
  ) {
    const body = parseJsonBody(event);
    requireString(body.id, "id");
    requireString(body.teamId, "teamId");
    requireString(body.senderActorId, "senderActorId");
    requireString(body.content, "content");

    const idempotencyKey = getHeader(event.headers, "idempotency-key");
    if (idempotencyKey && idempotencyKey !== body.id) {
      throw new ApiError(400, "validation_failed", "Idempotency-Key must match message id");
    }

    const message = await repository.insertMessage(decodeURIComponent(parts[2]), body);
    return { body: message };
  }

  if (method === "POST" && parts.length === 3 && parts[1] === "invites" && parts[2] === "claim") {
    const body = parseJsonBody(event);
    requireString(body.token, "token");
    const result = await repository.claimInvite(body.token);
    return { body: result };
  }

  throw new ApiError(404, "not_found", "Route not found");
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

function nextSessionCursor(items, limit) {
  if (!Array.isArray(items) || items.length < limit) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeCursor({
    lastMessageAt: last.lastMessageAt ?? null,
    createdAt: last.createdAt ?? null,
    id: last.id,
  });
}

function parseLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ApiError(400, "validation_failed", "limit must be an integer from 1 to 100");
  }
  return limit;
}

function queryParams(event) {
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

function normalizePath(path) {
  const withoutQuery = path.split("?")[0];
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function requireString(value, field) {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new ApiError(400, "validation_failed", `${field} is required`);
}

function optionalStringOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new ApiError(400, "validation_failed", `${field} must be a string or null`);
}
