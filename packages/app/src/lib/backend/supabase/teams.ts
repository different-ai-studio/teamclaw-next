import type { TeamsBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseTeamsBackend(_client: unknown): TeamsBackend {
  return {
    createTeam: async () => notImplemented("teams.createTeam"),
    renameTeam: async () => notImplemented("teams.renameTeam"),
    createTeamInvite: async () => notImplemented("teams.createTeamInvite"),
    removeTeamActor: async () => notImplemented("teams.removeTeamActor"),
  };
}
