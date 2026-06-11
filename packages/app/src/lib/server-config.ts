import type { BackendKind } from "@/lib/backend/types";
import { buildConfig } from "@/lib/build-config";

export interface ServerConfig {
  backendKind?: BackendKind;
  cloudApiUrl?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUseTls?: boolean;
  mqttUsername?: string;
  mqttPassword?: string;
}

// The Cloud API URL is owned entirely by the frontend build config
// (`build.config*.json` → `buildConfig.cloudApiUrl`), overridable only at
// build/dev time via the `VITE_CLOUD_API_URL` env var. There is no runtime
// override and no on-disk persistence: the legacy `~/.teamclaw/config.json`
// override (and the `window.__TEAMCLAW_SERVER_CONFIG__` injection that carried
// it) have been removed, because a stale persisted value could silently shadow
// the baked build config.
//
// This localStorage entry is a session cache for the MQTT broker config that the
// Cloud API delivers via `/v1/config/bootstrap` after sign-in — nothing else. It
// lets the MQTT client read a broker synchronously before bootstrap re-runs.
const STORAGE_KEY = "teamclaw.serverConfig";

function readLocalConfig(): ServerConfig {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ServerConfig;
  } catch {
    return {};
  }
}

function writeLocalConfig(config: ServerConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function envConfig(): ServerConfig {
  const mqttPort = Number(import.meta.env.VITE_MQTT_PORT ?? "");
  const rawUseTls = import.meta.env.VITE_MQTT_USE_TLS?.trim().toLowerCase();
  const mqttUseTls =
    rawUseTls === "true" || rawUseTls === "1"
      ? true
      : rawUseTls === "false" || rawUseTls === "0"
        ? false
        : undefined;
  return {
    backendKind: "cloud_api",
    // Env var wins; otherwise fall back to the value baked into build.config.*.
    cloudApiUrl: import.meta.env.VITE_CLOUD_API_URL || buildConfig.cloudApiUrl,
    mqttHost: import.meta.env.VITE_MQTT_HOST,
    mqttPort: Number.isFinite(mqttPort) ? mqttPort : undefined,
    mqttUseTls,
    mqttUsername: import.meta.env.VITE_MQTT_USERNAME,
    mqttPassword: import.meta.env.VITE_MQTT_PASSWORD,
  };
}

// Only the bootstrap-delivered MQTT broker config is persisted. cloudApiUrl and
// backendKind are intentionally dropped — they are never a runtime override.
function normalizeMqttConfig(config: ServerConfig): ServerConfig {
  return {
    mqttHost: config.mqttHost?.trim() || undefined,
    mqttPort: config.mqttPort,
    mqttUseTls: config.mqttUseTls,
    mqttUsername: config.mqttUsername?.trim() || undefined,
    mqttPassword: config.mqttPassword?.trim() || undefined,
  };
}

function hasOwn(config: ServerConfig, key: keyof ServerConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function resolve(rawSaved: ServerConfig): ServerConfig {
  const saved = normalizeMqttConfig(rawSaved);
  const env = envConfig();
  return {
    backendKind: "cloud_api",
    // Single source of truth: build config (env var override only). The saved
    // localStorage cache never contributes a cloudApiUrl.
    cloudApiUrl: env.cloudApiUrl,
    mqttHost: saved.mqttHost ?? env.mqttHost,
    mqttPort: saved.mqttPort ?? env.mqttPort,
    mqttUseTls: saved.mqttUseTls ?? env.mqttUseTls,
    mqttUsername: hasOwn(rawSaved, "mqttUsername") ? saved.mqttUsername : env.mqttUsername,
    mqttPassword: hasOwn(rawSaved, "mqttPassword") ? saved.mqttPassword : env.mqttPassword,
  };
}

export function getEffectiveServerConfigSync(): ServerConfig {
  return resolve(readLocalConfig());
}

export async function getSavedServerConfig(): Promise<ServerConfig> {
  return readLocalConfig();
}

export async function saveServerConfig(config: ServerConfig): Promise<ServerConfig> {
  const normalized = normalizeMqttConfig(config);
  writeLocalConfig(normalized);
  return { backendKind: "cloud_api", ...normalized };
}

export async function getEffectiveServerConfig(): Promise<ServerConfig> {
  return resolve(readLocalConfig());
}
