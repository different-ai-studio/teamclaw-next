import type { TeamWorkspaceConfigBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseTeamWorkspaceConfigBackend(_client: unknown): TeamWorkspaceConfigBackend {
  return {
    load: async () => notImplemented("teamWorkspaceConfig.load"),
    save: async () => notImplemented("teamWorkspaceConfig.save"),
  };
}
