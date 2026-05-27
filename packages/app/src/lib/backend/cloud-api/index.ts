import type { ServerConfig } from "@/lib/server-config";
import { createSupabaseBackend } from "../supabase";
import type { TeamClawBackend } from "../types";
import { createCloudApiClient, type CloudApiClient } from "./http";
import { createAuthModule } from "./auth";
import { createTeamsModule } from "./teams";
import { createSessionsModule } from "./sessions";
import { createMessagesModule } from "./messages";

export function hasCloudApiBackendConfig(config: ServerConfig): boolean {
  return Boolean(config.cloudApiUrl && config.supabaseUrl && config.supabaseAnonKey);
}

export function createCloudApiBackend(
  config: ServerConfig,
  options: { delegate?: TeamClawBackend; client?: CloudApiClient } = {},
): TeamClawBackend {
  const delegate = options.delegate ?? createSupabaseBackend();
  const client = options.client ?? createCloudApiClient({
    baseUrl: requiredCloudApiUrl(config),
    auth: delegate.auth,
  });

  return {
    ...delegate,
    kind: "cloud_api",
    auth: createAuthModule(client, delegate.auth),
    teams: createTeamsModule(client, delegate.teams),
    sessions: createSessionsModule(client, delegate.sessions),
    messages: createMessagesModule(client, delegate.messages),
  };
}

function requiredCloudApiUrl(config: ServerConfig): string {
  if (!config.cloudApiUrl) throw new Error("Cloud API URL is not configured.");
  return config.cloudApiUrl;
}
