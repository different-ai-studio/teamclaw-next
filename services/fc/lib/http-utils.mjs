import { randomUUID } from "node:crypto";

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export class ApiError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

export function getHeader(headers, name) {
  return normalizeHeaders(headers)[name.toLowerCase()];
}

export function resolveRequestId(headers = {}, makeId = randomUUID) {
  const incoming = getHeader(headers, "x-request-id");
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming;
  return makeId().replaceAll("-", "").slice(0, 32);
}

export function extractBearerToken(headers = {}) {
  const authorization = getHeader(headers, "authorization");
  if (!authorization) {
    throw new ApiError(401, "missing_auth", "Missing Authorization bearer token");
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]?.trim()) {
    throw new ApiError(401, "missing_auth", "Invalid Authorization bearer token");
  }

  return match[1].trim();
}

export function decodeBody(event = {}) {
  if (event.body === undefined || event.body === null || event.body === "") return "";
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf8");
  return String(event.body);
}

export function parseJsonBody(event = {}) {
  const raw = decodeBody(event);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON", { cause });
  }
}

export function jsonResponse(statusCode, body, requestId, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(error, requestId) {
  const normalized = normalizeError(error);
  return jsonResponse(
    normalized.statusCode,
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId,
      },
    },
    requestId,
  );
}

export function normalizeError(error) {
  if (error instanceof ApiError) return error;

  const mapped = mapSupabaseError(error);
  if (mapped) return mapped;

  return new ApiError(500, "internal", "Internal server error", { cause: error });
}

export function mapSupabaseError(error) {
  const pgCode = error?.code || error?.details?.code;
  const httpStatus = Number(error?.status || error?.statusCode || error?.httpStatus);
  const message = error?.message || "Supabase request failed";

  if (pgCode === "42501" || httpStatus === 403) {
    return new ApiError(403, "forbidden", message, { cause: error });
  }
  if (pgCode === "23505") {
    return new ApiError(409, "conflict", message, { cause: error });
  }
  if (pgCode === "23514" || pgCode === "22P02" || httpStatus === 400) {
    return new ApiError(400, "validation_failed", message, { cause: error });
  }
  if (httpStatus === 404) {
    return new ApiError(404, "not_found", message, { cause: error });
  }
  if (httpStatus === 401) {
    return new ApiError(401, "missing_auth", message, { cause: error });
  }
  if (httpStatus === 429) {
    return new ApiError(429, "rate_limited", message, { cause: error });
  }
  if (httpStatus >= 500 || error?.isSupabaseError) {
    return new ApiError(502, "upstream_unavailable", message, { cause: error });
  }

  return null;
}
