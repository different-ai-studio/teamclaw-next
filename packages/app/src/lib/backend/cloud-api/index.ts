import type { ServerConfig } from "@/lib/server-config";
import { createSupabaseBackend } from "../supabase";
import type { TeamClawBackend } from "../types";
import { createCloudApiClient, type CloudApiClient } from "./http";
import { createAuthModule } from "./auth";
import { createTeamsModule } from "./teams";
import { createSessionsModule } from "./sessions";
import { createMessagesModule } from "./messages";
import { createWorkspacesModule } from "./workspaces";
import { createTeamWorkspaceConfigModule } from "./team-workspace-config";
import { createActorsModule } from "./actors";
import { createDirectoryModule } from "./directory";
import { createSessionMembersModule } from "./session-members";
import { createIdeasModule } from "./ideas";
import { createShortcutsModule } from "./shortcuts";
import { createNotificationsModule } from "./notifications";
import { createRuntimeModule } from "./runtime";
import { createAttachmentsModule } from "./attachments";
import { createTelemetryModule } from "./telemetry";

export function hasCloudApiBackendConfig(config: ServerConfig): boolean {
  return Boolean(config.cloudApiUrl && config.supabaseUrl && config.supabaseAnonKey);
}

export function createCloudApiBackend(
  config: ServerConfig,
  options: { delegate?: TeamClawBackend; client?: CloudApiClient } = {},
): TeamClawBackend {
  // delegate is kept for domains not yet covered by /v1 endpoints:
  // - sync (no FC route)
  // - directory (no FC route)
  // - teamWorkspaceConfig (schema mismatch)
  // - actors.listActorDirectoryByIds (no bulk endpoint)
  // - actors.removeAgentAccess (accessId vs actorId mismatch)
  // - teams.removeTeamActor (no teamId in interface)
  // These will be removed in Phase D once FC routes are expanded.
  const delegate = options.delegate ?? createSupabaseBackend();
  const client = options.client ?? createCloudApiClient({
    baseUrl: requiredCloudApiUrl(config),
    auth: delegate.auth,
  });

  return {
    kind: "cloud_api",
    auth: createAuthModule(client, delegate.auth),
    teams: createTeamsModule(client, delegate.teams),
    sessions: createSessionsModule(client, delegate.sessions),
    messages: createMessagesModule(client, delegate.messages),
    workspaces: createWorkspacesModule(client, delegate.workspaces),
    teamWorkspaceConfig: createTeamWorkspaceConfigModule(client, delegate.teamWorkspaceConfig),
    actors: createActorsModule(client, delegate.actors),
    directory: createDirectoryModule(client, delegate.directory),
    sessionMembers: createSessionMembersModule(client, delegate.sessionMembers),
    ideas: createIdeasModule(client, delegate.ideas),
    shortcuts: createShortcutsModule(client, delegate.shortcuts),
    notifications: createNotificationsModule(client, delegate.notifications),
    runtime: createRuntimeModule(client, delegate.runtime),
    attachments: createAttachmentsModule(client, delegate.attachments),
    telemetry: createTelemetryModule(client, delegate.telemetry),
    // sync has no /v1 endpoint yet; keep Supabase passthrough
    sync: delegate.sync,
  };
}

function requiredCloudApiUrl(config: ServerConfig): string {
  if (!config.cloudApiUrl) throw new Error("Cloud API URL is not configured.");
  return config.cloudApiUrl;
}
