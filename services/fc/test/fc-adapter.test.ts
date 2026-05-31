import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { handler } from "../src/index.js";

function fcEvent(method: string, path: string, opts: { headers?: any; body?: any } = {}) {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: opts.headers ?? {},
    body: opts.body ? JSON.stringify(opts.body) : "",
    isBase64Encoded: false,
    queryStringParameters: {},
  };
}

test("OPTIONS -> 204", async () => {
  const res: any = await handler(fcEvent("OPTIONS", "/v1/teams"), {});
  assert.equal(res.statusCode, 204);
});

test("unknown /v1 route -> 404 envelope", async () => {
  const res: any = await handler(fcEvent("GET", "/v1/nope", { headers: { authorization: "Bearer x" } }), {});
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error.code, "not_found");
});

test("Buffer event is parsed", async () => {
  const ev = Buffer.from(JSON.stringify(fcEvent("OPTIONS", "/v1/teams")));
  const res: any = await handler(ev, {});
  assert.equal(res.statusCode, 204);
});

test("string event is parsed", async () => {
  const ev = JSON.stringify(fcEvent("OPTIONS", "/v1/teams"));
  const res: any = await handler(ev, {});
  assert.equal(res.statusCode, 204);
});

test("hono/aws-lambda base64-encodes binary (png) round-trip", async () => {
  const app = new Hono();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  app.get("/f", () => new Response(png, { headers: { "Content-Type": "image/png" } }));
  const res: any = await handle(app)(
    {
      rawPath: "/f",
      requestContext: { http: { method: "GET" } },
      headers: {},
      isBase64Encoded: false,
      queryStringParameters: {},
    } as any,
    {} as any,
  );
  assert.equal(res.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(res.body, "base64"), png);
});
