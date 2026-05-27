// services/fc/lib/supabase.mjs
//
// Thin wrapper so every module can get a service-role Supabase client without
// importing index.mjs (which would create a circular dep).

import { createClient } from '@supabase/supabase-js';

/**
 * Return a Supabase client authenticated as service_role.
 * Callers should NOT cache this across invocations; FC is stateless and ENV
 * may change between warm-starts in local dev.
 */
export function createServiceRoleClient() {
  const url  = process.env.SUPABASE_URL            || '';
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return createClient(url, key, { auth: { persistSession: false } });
}
