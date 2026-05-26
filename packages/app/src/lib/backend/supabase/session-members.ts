import type { SessionMembersBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseSessionMembersBackend(_client: unknown): SessionMembersBackend {
  return {
    listParticipants: async () => notImplemented("sessionMembers.listParticipants"),
    listCandidateActors: async () => notImplemented("sessionMembers.listCandidateActors"),
    addParticipant: async () => notImplemented("sessionMembers.addParticipant"),
    removeParticipant: async () => notImplemented("sessionMembers.removeParticipant"),
  };
}
