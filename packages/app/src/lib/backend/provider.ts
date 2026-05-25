import {
  hasSupabaseConfig,
  SUPABASE_CONFIG_MISSING_MESSAGE,
} from "@/lib/supabase-client";
import { createSupabaseBackend } from "./supabase";
import type { TeamClawBackend } from "./types";

export const BACKEND_CONFIG_MISSING_MESSAGE = SUPABASE_CONFIG_MISSING_MESSAGE;

let backend: TeamClawBackend | null = null;

export function hasBackendConfig(): boolean {
  return hasSupabaseConfig;
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
