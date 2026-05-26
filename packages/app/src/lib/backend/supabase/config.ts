export const BACKEND_CONFIG_MISSING_MESSAGE =
  "Supabase config missing. Configure a server before signing in.";

function injectedSupabaseConfig(): { supabaseUrl?: string; supabaseAnonKey?: string } {
  if (typeof window === "undefined") return {};
  return window.__TEAMCLAW_SERVER_CONFIG__ ?? {};
}

function savedSupabaseConfig(): { supabaseUrl?: string; supabaseAnonKey?: string } {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem("teamclaw.serverConfig");
    if (!raw) return {};
    return JSON.parse(raw) as { supabaseUrl?: string; supabaseAnonKey?: string };
  } catch {
    return {};
  }
}

export function getSupabaseBackendConfig(): { url: string | null; anonKey: string | null } {
  const injected = injectedSupabaseConfig();
  const saved = savedSupabaseConfig();
  return {
    url: injected.supabaseUrl || saved.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || null,
    anonKey:
      injected.supabaseAnonKey || saved.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || null,
  };
}

export function hasSupabaseBackendConfig(): boolean {
  const config = getSupabaseBackendConfig();
  return Boolean(config.url && config.anonKey);
}
