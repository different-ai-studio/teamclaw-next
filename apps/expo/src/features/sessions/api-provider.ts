import type { SupabaseClient } from "@supabase/supabase-js";
import { createCloudSessionsApi } from "./cloud-api";

export function createConfiguredSessionsApi(client: SupabaseClient) {
  return createCloudSessionsApi({
    getAccessToken: async () => {
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    },
  });
}
