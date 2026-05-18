import { createClient } from "@supabase/supabase-js";

function injectedSupabaseConfig(): { supabaseUrl?: string; supabaseAnonKey?: string } {
  if (typeof window === "undefined") return {};
  return window.__TEAMCLAW_SERVER_CONFIG__ ?? {};
}

function savedSupabaseConfig(): { supabaseUrl?: string; supabaseAnonKey?: string } {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem("teamclaw.serverConfig");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { supabaseUrl?: string; supabaseAnonKey?: string };
    return parsed;
  } catch {
    return {};
  }
}

const injected = injectedSupabaseConfig();
const saved = savedSupabaseConfig();
const configuredUrl = injected.supabaseUrl || saved.supabaseUrl || import.meta.env.VITE_SUPABASE_URL;
const configuredAnonKey =
  injected.supabaseAnonKey || saved.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(configuredUrl && configuredAnonKey);
export const SUPABASE_CONFIG_MISSING_MESSAGE =
  "Supabase config missing. Configure a server before signing in.";

if (!hasSupabaseConfig) {
  console.warn(
    "Supabase config missing; using local placeholder client until server settings are configured.",
  );
}

const url = configuredUrl || "http://127.0.0.1:54321";
const anonKey = configuredAnonKey || "missing-supabase-anon-key";

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
