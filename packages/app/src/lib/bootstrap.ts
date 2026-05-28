import {
  getEffectiveServerConfig,
  getSavedServerConfig,
  saveServerConfig,
  type ServerConfig,
} from "@/lib/server-config";

interface BootstrapMqttPayload {
  url?: string;
  username?: string | null;
  password?: string | null;
  useTls?: boolean | null;
}

interface BootstrapPayload {
  mqtt?: BootstrapMqttPayload;
}

function parseBrokerUrl(raw: string): { host: string; port?: number; useTls?: boolean } | null {
  try {
    const url = new URL(raw);
    const scheme = url.protocol.replace(/:$/, "");
    const useTls = scheme === "mqtts" || scheme === "wss";
    const port = url.port ? Number(url.port) : undefined;
    if (!url.hostname) return null;
    return { host: url.hostname, port: Number.isFinite(port) ? port : undefined, useTls };
  } catch {
    return null;
  }
}

function patchFromPayload(mqtt: BootstrapMqttPayload | undefined): Partial<ServerConfig> | null {
  if (!mqtt?.url) return null;
  const parsed = parseBrokerUrl(mqtt.url);
  if (!parsed) return null;
  return {
    mqttHost: parsed.host,
    mqttPort: parsed.port,
    mqttUseTls: mqtt.useTls ?? parsed.useTls,
    mqttUsername: mqtt.username ?? undefined,
    mqttPassword: mqtt.password ?? undefined,
  };
}

// Drop every field that bootstrap may write so a different account
// doesn't inherit the previous user's MQTT broker / credentials. Called
// from auth-store.signOut. cloudApiUrl is left alone — it's user-supplied,
// not bootstrap-delivered.
export async function clearBootstrapAppliedFields(): Promise<void> {
  const saved = await getSavedServerConfig();
  await saveServerConfig({
    ...saved,
    mqttHost: undefined,
    mqttPort: undefined,
    mqttUseTls: undefined,
    mqttUsername: undefined,
    mqttPassword: undefined,
  });
}

// Bootstrap is best-effort: any failure leaves the existing client config in
// place. The function never throws so callers can fire-and-forget after sign-in.
export async function fetchAndApplyBootstrap(args: {
  accessToken: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const token = args.accessToken?.trim();
  if (!token) return;
  const effective = await getEffectiveServerConfig();
  const baseUrl = effective.cloudApiUrl?.replace(/\/+$/, "");
  if (!baseUrl) return;
  const fetchImpl = args.fetchImpl ?? fetch;
  let body: BootstrapPayload;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/config/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    body = (await res.json()) as BootstrapPayload;
  } catch {
    return;
  }
  const patch = patchFromPayload(body.mqtt);
  if (!patch) return;
  const saved = await getSavedServerConfig();
  await saveServerConfig({ ...saved, ...patch });
}
