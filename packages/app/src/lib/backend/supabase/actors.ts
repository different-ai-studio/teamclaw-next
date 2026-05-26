import type { ActorsBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseActorsBackend(_client: unknown): ActorsBackend {
  return {
    listActorDirectory: async () => notImplemented("actors.listActorDirectory"),
    listConnectedAgents: async () => notImplemented("actors.listConnectedAgents"),
    updateOwnedAgentProfile: async () => notImplemented("actors.updateOwnedAgentProfile"),
    updateAgentDefaults: async () => notImplemented("actors.updateAgentDefaults"),
  };
}
