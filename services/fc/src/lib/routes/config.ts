// Runtime configuration delivered to authenticated clients on startup.
// Auth is enforced (bearer required) so we never leak broker credentials,
// but the response is built from FC env vars rather than the data backend.

function parseBool(raw) {
  if (raw == null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

function buildMqttConfig() {
  const url = process.env.MQTT_BROKER_URL?.trim();
  if (!url) return null;
  const mqtt: any = { url };
  const username = process.env.MQTT_USERNAME?.trim();
  const password = process.env.MQTT_PASSWORD?.trim();
  const useTls = parseBool(process.env.MQTT_USE_TLS);
  if (username) mqtt.username = username;
  if (password) mqtt.password = password;
  if (useTls !== undefined) mqtt.useTls = useTls;
  return mqtt;
}

export function buildBootstrapConfig() {
  const config: any = {};
  const mqtt = buildMqttConfig();
  if (mqtt) config.mqtt = mqtt;
  return config;
}

export function registerConfig(router) {
  router.get("/v1/config/bootstrap", async () => {
    return { body: buildBootstrapConfig() };
  });
}
