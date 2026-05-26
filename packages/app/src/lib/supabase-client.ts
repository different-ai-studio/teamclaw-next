import { createClient } from "@supabase/supabase-js";
import {
  BACKEND_CONFIG_MISSING_MESSAGE,
  getSupabaseBackendConfig,
  hasSupabaseBackendConfig,
} from "@/lib/backend/supabase/config";

const { url: configuredUrl, anonKey: configuredAnonKey } = getSupabaseBackendConfig();

export const hasSupabaseConfig = Boolean(configuredUrl && configuredAnonKey);
export const SUPABASE_CONFIG_MISSING_MESSAGE = BACKEND_CONFIG_MISSING_MESSAGE;
export { hasSupabaseBackendConfig };

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
