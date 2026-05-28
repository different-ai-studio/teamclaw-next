import { createSupabaseBackend } from "./supabase";
import {
  BACKEND_CONFIG_MISSING_MESSAGE,
  hasSupabaseBackendConfig,
} from "./supabase/config";
import {
  createPocketBaseBackend,
  hasPocketBaseBackendConfig,
} from "./pocketbase";
import {
  createCloudApiBackend,
  hasCloudApiBackendConfig,
} from "./cloud-api";
import { getEffectiveServerConfigSync } from "../server-config";
import type { BackendKind, TeamClawBackend } from "./types";

export { BACKEND_CONFIG_MISSING_MESSAGE };

let backend: TeamClawBackend | null = null;
let backendCacheKey: string | null = null;

export function getBackendKind(): Extract<BackendKind, "supabase" | "pocketbase" | "cloud_api"> {
  const config = getEffectiveServerConfigSync();
  if (config.backendKind === "cloud_api") return "cloud_api";
  return config.backendKind === "pocketbase" ? "pocketbase" : "supabase";
}

export function hasBackendConfig(): boolean {
  const config = getEffectiveServerConfigSync();
  if (getBackendKind() === "pocketbase") {
    return hasPocketBaseBackendConfig(config);
  }
  if (getBackendKind() === "cloud_api") {
    return hasCloudApiBackendConfig(config);
  }
  return hasSupabaseBackendConfig();
}

export function getBackend(): TeamClawBackend {
  const config = getEffectiveServerConfigSync();
  const kind = getBackendKind();
  const cacheKey =
    kind === "pocketbase"
      ? `${kind}:${config.pocketbaseUrl ?? ""}`
      : kind === "cloud_api"
        ? `${kind}:${config.cloudApiUrl ?? ""}:${config.supabaseUrl ?? ""}:${config.supabaseAnonKey ?? ""}`
        : `${kind}:${config.supabaseUrl ?? ""}:${config.supabaseAnonKey ?? ""}`;

  if (!backend || backendCacheKey !== cacheKey) {
    backend =
      kind === "pocketbase"
        ? createPocketBaseBackend(config)
        : kind === "cloud_api"
          ? (hasCloudApiBackendConfig(config) ? createCloudApiBackend(config) : createSupabaseBackend())
          : createSupabaseBackend();
    backendCacheKey = cacheKey;
  }
  return backend;
}

export function resetBackendForTests(): void {
  backend = null;
  backendCacheKey = null;
}
