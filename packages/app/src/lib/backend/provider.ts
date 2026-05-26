import { createSupabaseBackend } from "./supabase";
import {
  BACKEND_CONFIG_MISSING_MESSAGE,
  hasSupabaseBackendConfig,
} from "./supabase/config";
import type { TeamClawBackend } from "./types";

export { BACKEND_CONFIG_MISSING_MESSAGE };

let backend: TeamClawBackend | null = null;

export function hasBackendConfig(): boolean {
  return hasSupabaseBackendConfig();
}

export function getBackend(): TeamClawBackend {
  if (!backend) {
    backend = createSupabaseBackend();
  }
  return backend;
}

export function resetBackendForTests(): void {
  backend = null;
}
