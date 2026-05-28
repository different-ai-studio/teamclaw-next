import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  errorResponse,
  extractBearerToken,
  mapSupabaseError,
  parseJsonBody,
  resolveRequestId,
} from "../lib/http-utils.mjs";

test("resolveRequestId reuses only log-safe request ids", () => {
  assert.equal(resolveRequestId({ "X-Request-Id": "abcDEF_123-xyz" }), "abcDEF_123-xyz");
  assert.equal(resolveRequestId({ "X-Request-Id": "../bad" }, () => "generated-id-123"), "generatedid123");
  assert.equal(resolveRequestId({}, () => "01234567-89ab-cdef-0123-456789abcdef"), "0123456789abcdef0123456789abcdef");
});

test("extractBearerToken accepts case-insensitive bearer headers", () => {
  assert.equal(extractBearerToken({ authorization: "Bearer token-1" }), "token-1");
  assert.equal(extractBearerToken({ Authorization: "bearer token-2 " }), "token-2");
});

test("extractBearerToken rejects missing or malformed authorization", () => {
  assert.throws(() => extractBearerToken({}), /Missing Authorization/);
  assert.throws(() => extractBearerToken({ authorization: "Basic abc" }), /Invalid Authorization/);
});

test("parseJsonBody decodes plain and base64 json bodies", () => {
  assert.deepEqual(parseJsonBody({ body: '{"a":1}' }), { a: 1 });
  assert.deepEqual(
    parseJsonBody({ body: Buffer.from('{"b":2}').toString("base64"), isBase64Encoded: true }),
    { b: 2 },
  );
  assert.deepEqual(parseJsonBody({}), {});
});

test("parseJsonBody returns invalid_json for malformed bodies", () => {
  assert.throws(() => parseJsonBody({ body: "{" }), (err) => {
    assert.equal(err.code, "invalid_json");
    assert.equal(err.statusCode, 400);
    return true;
  });
});

test("mapSupabaseError keeps business errors client-actionable", () => {
  assert.deepEqual(
    pick(mapSupabaseError({ code: "42501", message: "rls denied" })),
    { statusCode: 403, code: "forbidden", message: "rls denied" },
  );
  assert.deepEqual(
    pick(mapSupabaseError({ code: "23505", message: "duplicate key" })),
    { statusCode: 409, code: "conflict", message: "duplicate key" },
  );
  assert.deepEqual(
    pick(mapSupabaseError({ code: "23514", message: "check failed" })),
    { statusCode: 400, code: "validation_failed", message: "check failed" },
  );
  assert.deepEqual(
    pick(mapSupabaseError({ status: 404, message: "missing row" })),
    { statusCode: 404, code: "not_found", message: "missing row" },
  );
});

test("errorResponse emits stable envelope and request header", () => {
  const response = errorResponse(new ApiError(409, "conflict", "Already exists"), "req_12345678");
  assert.equal(response.statusCode, 409);
  assert.equal(response.headers["X-Request-Id"], "req_12345678");
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: "conflict",
      message: "Already exists",
      requestId: "req_12345678",
    },
  });
});

function pick(error) {
  return {
    statusCode: error.statusCode,
    code: error.code,
    message: error.message,
  };
}
