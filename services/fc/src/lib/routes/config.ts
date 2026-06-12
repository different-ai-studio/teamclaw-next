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

// Web SSO 快捷登录 target, delivered to clients so the Betly admin sign-in URL
// and supabase-js storage key are not hardcoded in the app. Env-driven like the
// MQTT block. storageKey is `sb-<supabase-ref>-auth-token` and can't be derived
// from the admin host, so it is its own variable.
function buildWebSsoConfig() {
  const loginUrl = process.env.WEBSSO_LOGIN_URL?.trim();
  if (!loginUrl) return null;
  const webSso: any = { loginUrl };
  const storageKey = process.env.WEBSSO_STORAGE_KEY?.trim();
  if (storageKey) webSso.storageKey = storageKey;
  return webSso;
}

export function buildBootstrapConfig() {
  const config: any = {};
  const mqtt = buildMqttConfig();
  if (mqtt) config.mqtt = mqtt;
  const webSso = buildWebSsoConfig();
  if (webSso) config.webSso = webSso;
  return config;
}

// Non-sensitive config that clients need BEFORE they have a session — currently
// just the Web SSO 快捷登录 target, which is a login method (the authed bootstrap
// above runs only post-sign-in, too late for the login screen). No bearer; never
// includes the MQTT broker credentials.
export function buildPublicConfig() {
  const config: any = {};
  const webSso = buildWebSsoConfig();
  if (webSso) config.webSso = webSso;
  return config;
}

export function registerConfig(router) {
  router.get("/v1/config/bootstrap", async () => {
    return { body: buildBootstrapConfig() };
  });
  router.get("/v1/config/public", { auth: "none" }, async () => {
    return { body: buildPublicConfig() };
  });
}
