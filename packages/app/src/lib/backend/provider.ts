import { createSupabaseBackend } from "./supabase";
import {
  BACKEND_CONFIG_MISSING_MESSAGE,
  hasSupabaseBackendConfig,
} from "./supabase/config";
import {
  createPocketBaseBackend,
  hasPocketBaseBackendConfig,
} from "./pocketbase";
import { getEffectiveServerConfigSync } from "../server-config";
import type { TeamClawBackend } from "./types";

export { BACKEND_CONFIG_MISSING_MESSAGE };

let backend: TeamClawBackend | null = null;
let backendCacheKey: string | null = null;

export function hasBackendConfig(): boolean {
  const config = getEffectiveServerConfigSync();
  if (config.backendKind === "pocketbase") {
    return hasPocketBaseBackendConfig(config);
  }
  return hasSupabaseBackendConfig();
}

export function getBackend(): TeamClawBackend {
  const config = getEffectiveServerConfigSync();
  const kind = config.backendKind === "pocketbase" ? "pocketbase" : "supabase";
  const cacheKey =
    kind === "pocketbase"
      ? `${kind}:${config.pocketbaseUrl ?? ""}`
      : `${kind}:${config.supabaseUrl ?? ""}:${config.supabaseAnonKey ?? ""}`;

  if (!backend || backendCacheKey !== cacheKey) {
    backend =
      kind === "pocketbase"
        ? createPocketBaseBackend(config)
        : createSupabaseBackend();
    backendCacheKey = cacheKey;
  }
  return backend;
}

export function resetBackendForTests(): void {
  backend = null;
  backendCacheKey = null;
}
