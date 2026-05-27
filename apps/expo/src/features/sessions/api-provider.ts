import type { SupabaseClient } from "@supabase/supabase-js";
import { createCloudSessionsApi } from "./cloud-api";
import { createSessionsApi } from "./session-api";

export function createConfiguredSessionsApi(client: SupabaseClient) {
  const delegate = createSessionsApi(client);
  const baseUrl = process.env.EXPO_PUBLIC_CLOUD_API_URL?.trim();
  if (process.env.EXPO_PUBLIC_BACKEND_KIND !== "cloud_api" || !baseUrl) {
    return delegate;
  }

  return createCloudSessionsApi({
    baseUrl,
    delegate,
    getAccessToken: async () => {
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    },
  });
}
