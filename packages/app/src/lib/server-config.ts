import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/utils";
import type { BackendKind } from "@/lib/backend/types";

export interface ServerConfig {
  backendKind?: BackendKind;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  pocketbaseUrl?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUseTls?: boolean;
  mqttUsername?: string;
  mqttPassword?: string;
}

const STORAGE_KEY = "teamclaw.serverConfig";

function readLocalConfig(): ServerConfig {
  if (typeof window === "undefined") return {};
  if (window.__TEAMCLAW_SERVER_CONFIG__) return window.__TEAMCLAW_SERVER_CONFIG__;
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
    backendKind: normalizeBackendKind(import.meta.env.VITE_BACKEND_KIND),
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    pocketbaseUrl: import.meta.env.VITE_POCKETBASE_URL,
    mqttHost: import.meta.env.VITE_MQTT_HOST,
    mqttPort: Number.isFinite(mqttPort) ? mqttPort : undefined,
    mqttUseTls,
    mqttUsername: import.meta.env.VITE_MQTT_USERNAME,
    mqttPassword: import.meta.env.VITE_MQTT_PASSWORD,
  };
}

function normalizeBackendKind(kind: unknown): BackendKind | undefined {
  if (kind === "supabase" || kind === "pocketbase" || kind === "local") return kind;
  return undefined;
}

function normalizeServerConfig(config: ServerConfig): ServerConfig {
  return {
    backendKind: normalizeBackendKind(config.backendKind),
    supabaseUrl: config.supabaseUrl?.trim() || undefined,
    supabaseAnonKey: config.supabaseAnonKey?.trim() || undefined,
    pocketbaseUrl: config.pocketbaseUrl?.trim() || undefined,
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

export function getEffectiveServerConfigSync(): ServerConfig {
  const rawSaved = readLocalConfig();
  const saved = normalizeServerConfig(rawSaved);
  const env = envConfig();
  return {
    backendKind: saved.backendKind ?? env.backendKind ?? "supabase",
    supabaseUrl: saved.supabaseUrl ?? env.supabaseUrl,
    supabaseAnonKey: saved.supabaseAnonKey ?? env.supabaseAnonKey,
    pocketbaseUrl: saved.pocketbaseUrl ?? env.pocketbaseUrl,
    mqttHost: saved.mqttHost ?? env.mqttHost,
    mqttPort: saved.mqttPort ?? env.mqttPort,
    mqttUseTls: saved.mqttUseTls ?? env.mqttUseTls,
    mqttUsername: hasOwn(rawSaved, "mqttUsername") ? saved.mqttUsername : env.mqttUsername,
    mqttPassword: hasOwn(rawSaved, "mqttPassword") ? saved.mqttPassword : env.mqttPassword,
  };
}

export async function getSavedServerConfig(): Promise<ServerConfig> {
  if (!isTauri()) return readLocalConfig();
  try {
    const config = await invoke<ServerConfig>("get_server_config");
    writeLocalConfig(config);
    return config;
  } catch {
    return readLocalConfig();
  }
}

export async function saveServerConfig(config: ServerConfig): Promise<ServerConfig> {
  const normalized = normalizeServerConfig(config);

  writeLocalConfig(normalized);
  if (!isTauri()) return normalized;
  const saved = await invoke<ServerConfig>("save_server_config", { config: normalized });
  writeLocalConfig(saved);
  return saved;
}

export async function getEffectiveServerConfig(): Promise<ServerConfig> {
  const rawSaved = await getSavedServerConfig();
  const saved = normalizeServerConfig(rawSaved);
  const env = envConfig();
  return {
    backendKind: saved.backendKind ?? env.backendKind ?? "supabase",
    supabaseUrl: saved.supabaseUrl ?? env.supabaseUrl,
    supabaseAnonKey: saved.supabaseAnonKey ?? env.supabaseAnonKey,
    pocketbaseUrl: saved.pocketbaseUrl ?? env.pocketbaseUrl,
    mqttHost: saved.mqttHost ?? env.mqttHost,
    mqttPort: saved.mqttPort ?? env.mqttPort,
    mqttUseTls: saved.mqttUseTls ?? env.mqttUseTls,
    mqttUsername: hasOwn(rawSaved, "mqttUsername") ? saved.mqttUsername : env.mqttUsername,
    mqttPassword: hasOwn(rawSaved, "mqttPassword") ? saved.mqttPassword : env.mqttPassword,
  };
}
