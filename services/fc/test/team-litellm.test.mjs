import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../lib/business-api.mjs";
import { ApiError } from "../lib/http-utils.mjs";

function bearerHeaders() {
  return { Authorization: "Bearer test-token", "X-Request-Id": "req_litellm_test" };
}

function makeRepo({ result, error } = {}) {
  const calls = [];
  return {
    calls,
    async setupLiteLlm(teamId) {
      calls.push({ method: "setupLiteLlm", teamId });
      if (error) throw error;
      return result ?? { aiGatewayEndpoint: "https://gw.example.com", litellmKey: "sk-test" };
    },
  };
}

test("POST /v1/teams/:id/litellm/setup → 200 returns gateway + key", async () => {
  const repo = makeRepo();
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/litellm/setup",
    headers: bearerHeaders(),
    body: "{}",
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    aiGatewayEndpoint: "https://gw.example.com",
    litellmKey: "sk-test",
  });
  assert.deepEqual(repo.calls[0], { method: "setupLiteLlm", teamId: "team-1" });
});

test("POST /v1/teams/:id/litellm/setup repo throws ApiError 503 → 503 surfaced", async () => {
  const err = new ApiError(503, "litellm_unavailable", "LiteLLM provisioning is not configured");
  const repo = makeRepo({ error: err });
  const res = await handleBusinessApiRequest({
    httpMethod: "POST",
    path: "/v1/teams/team-1/litellm/setup",
    headers: bearerHeaders(),
    body: "{}",
  }, { createRepository: () => repo });

  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error.code, "litellm_unavailable");
});
