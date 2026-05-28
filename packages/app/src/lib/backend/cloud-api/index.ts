import type { ServerConfig } from "@/lib/server-config";
import { createSupabaseBackend } from "../supabase";
import type { TeamClawBackend } from "../types";
import { createCloudApiClient, type CloudApiClient } from "./http";
import { createAuthClient, createAuthModule } from "./auth";
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
  return Boolean(config.cloudApiUrl);
}

export function createCloudApiBackend(
  config: ServerConfig,
  options: { delegate?: TeamClawBackend; client?: CloudApiClient } = {},
): TeamClawBackend {
  // The Supabase delegate is still used to back the long tail of methods that
  // do not yet have a /v1 FC endpoint (telemetry, runtime, shortcuts,
  // notifications, several sessions/messages history paths, sync, etc.). The
  // Auth surface, however, has been fully migrated to the FC /v1/auth/*
  // proxy + the in-process SessionStore — see ./auth.ts and @/lib/auth.
  const delegate = options.delegate ?? createSupabaseBackend();
  const baseUrl = requiredCloudApiUrl(config);
  const authClient = createAuthClient({ baseUrl });
  // Build a temporary auth backend so the CloudApiClient can pull the bearer
  // token from the SessionStore. This is the FC auth backend — it does not
  // touch the Supabase delegate.
  const tempAuth = createAuthModule(/* client */ null as unknown as CloudApiClient, authClient);
  const client = options.client ?? createCloudApiClient({ baseUrl, auth: tempAuth });
  const auth = createAuthModule(client, authClient);

  return {
    kind: "cloud_api",
    auth,
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
    sync: delegate.sync,
  };
}

function requiredCloudApiUrl(config: ServerConfig): string {
  if (!config.cloudApiUrl) throw new Error("Cloud API URL is not configured.");
  return config.cloudApiUrl;
}
