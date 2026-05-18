import { createClient } from "@supabase/supabase-js";

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

const saved = savedSupabaseConfig();
const url = saved.supabaseUrl || import.meta.env.VITE_SUPABASE_URL;
const anonKey = saved.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing");
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
