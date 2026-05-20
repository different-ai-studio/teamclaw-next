import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/utils";

export interface ServerConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUseTls?: boolean;
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
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    mqttHost: import.meta.env.VITE_MQTT_HOST,
    mqttPort: Number.isFinite(mqttPort) ? mqttPort : undefined,
    mqttUseTls,
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
  const normalized: ServerConfig = {
    supabaseUrl: config.supabaseUrl?.trim() || undefined,
    supabaseAnonKey: config.supabaseAnonKey?.trim() || undefined,
    mqttHost: config.mqttHost?.trim() || undefined,
    mqttPort: config.mqttPort,
    mqttUseTls: config.mqttUseTls,
  };

  writeLocalConfig(normalized);
  if (!isTauri()) return normalized;
  const saved = await invoke<ServerConfig>("save_server_config", { config: normalized });
  writeLocalConfig(saved);
  return saved;
}

export async function getEffectiveServerConfig(): Promise<ServerConfig> {
  const saved = await getSavedServerConfig();
  const env = envConfig();
  return {
    supabaseUrl: saved.supabaseUrl ?? env.supabaseUrl,
    supabaseAnonKey: saved.supabaseAnonKey ?? env.supabaseAnonKey,
    mqttHost: saved.mqttHost ?? env.mqttHost,
    mqttPort: saved.mqttPort ?? env.mqttPort,
    mqttUseTls: saved.mqttUseTls ?? env.mqttUseTls,
  };
}
