import type { ServerConfig } from "@/lib/server-config";
import type { TeamClawBackend } from "../types";
import { createUnsupportedPocketBaseService } from "./unsupported";

export const POCKETBASE_CONFIG_MISSING_MESSAGE =
  "PocketBase config missing. Configure a PocketBase URL before signing in.";

export function hasPocketBaseBackendConfig(config: ServerConfig): boolean {
  return Boolean(config.pocketbaseUrl?.trim());
}

export function createPocketBaseBackend(_config: ServerConfig): TeamClawBackend {
  return {
    kind: "pocketbase",
    auth: createUnsupportedPocketBaseService("auth"),
    directory: createUnsupportedPocketBaseService("directory"),
    sessions: createUnsupportedPocketBaseService("sessions"),
    messages: createUnsupportedPocketBaseService("messages"),
    runtime: createUnsupportedPocketBaseService("runtime"),
    attachments: createUnsupportedPocketBaseService("attachments"),
    teams: createUnsupportedPocketBaseService("teams"),
    ideas: createUnsupportedPocketBaseService("ideas"),
    actors: createUnsupportedPocketBaseService("actors"),
    sessionMembers: createUnsupportedPocketBaseService("sessionMembers"),
    shortcuts: createUnsupportedPocketBaseService("shortcuts"),
    notifications: createUnsupportedPocketBaseService("notifications"),
    teamWorkspaceConfig: createUnsupportedPocketBaseService("teamWorkspaceConfig"),
    workspaces: createUnsupportedPocketBaseService("workspaces"),
    sync: createUnsupportedPocketBaseService("sync"),
    telemetry: createUnsupportedPocketBaseService("telemetry"),
  };
}
