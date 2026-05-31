import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBusinessApiRequest } from "../src/lib/business-api.js";
import { buildBootstrapConfig } from "../src/lib/routes/config.js";

function withEnv(overrides: Record<string, any>, fn: () => any) {
  const restore: Record<string, any> = {};
  for (const [key, value] of Object.entries(overrides)) {
    restore[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("buildBootstrapConfig returns mqtt block when env is set", () => {
  withEnv(
    {
      MQTT_BROKER_URL: "mqtts://mqtt.example.com:8883",
      MQTT_USERNAME: "user-1",
      MQTT_PASSWORD: "secret",
      MQTT_USE_TLS: "true",
    },
    () => {
      const cfg = buildBootstrapConfig();
      assert.deepEqual(cfg, {
        mqtt: {
          url: "mqtts://mqtt.example.com:8883",
          username: "user-1",
          password: "secret",
          useTls: true,
        },
      });
    },
  );
});

test("buildBootstrapConfig omits mqtt when broker url is missing", () => {
  withEnv(
    {
      MQTT_BROKER_URL: undefined,
      MQTT_USERNAME: "user-1",
      MQTT_PASSWORD: "secret",
      MQTT_USE_TLS: "true",
    },
    () => {
      assert.deepEqual(buildBootstrapConfig(), {});
    },
  );
});

test("GET /v1/config/bootstrap requires bearer auth", async () => {
  const response = await handleBusinessApiRequest(
    { httpMethod: "GET", path: "/v1/config/bootstrap", headers: {} },
    { createRepository: () => ({}), createAuthRepository: () => ({}) },
  );
  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body);
  assert.equal(body.error.code, "missing_auth");
});

test("GET /v1/config/bootstrap returns env-derived mqtt config to authed callers", async () => {
  await withEnv(
    {
      MQTT_BROKER_URL: "wss://mqtt.example.com:8884",
      MQTT_USERNAME: undefined,
      MQTT_PASSWORD: undefined,
      MQTT_USE_TLS: undefined,
    },
    async () => {
      const response = await handleBusinessApiRequest(
        {
          httpMethod: "GET",
          path: "/v1/config/bootstrap",
          headers: { Authorization: "Bearer caller-token" },
        },
        { createRepository: () => ({}), createAuthRepository: () => ({}) },
      );
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body, {
        mqtt: { url: "wss://mqtt.example.com:8884" },
      });
    },
  );
});
