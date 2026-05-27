import type { CurrentTeamMemberSummary, DirectoryBackend, DirectoryMemberActor } from "../types";
import type { CloudApiClient } from "./http";

type CloudDirectoryMember = {
  id: string;
  teamId?: string;
  displayName?: string;
  role?: string | null;
  joinedAt?: string | null;
};

export function createDirectoryModule(client: CloudApiClient, delegate: DirectoryBackend): DirectoryBackend {
  return {
    // Directory resolution needs user-id-based lookup which requires Supabase auth context.
    // The FC /v1/teams/:teamId/directory endpoint may not exist yet or may not cover all methods.
    // Delegate all directory calls until /v1 endpoint is expanded.
    ...delegate,
    async resolveCurrentMemberActor(teamId: string, userId: string): Promise<DirectoryMemberActor | null> {
      return delegate.resolveCurrentMemberActor(teamId, userId);
    },
    async resolveFirstMemberActorForUser(userId: string): Promise<DirectoryMemberActor | null> {
      return delegate.resolveFirstMemberActorForUser(userId);
    },
    async getCurrentTeamMember(teamId: string, userId: string): Promise<CurrentTeamMemberSummary | null> {
      return delegate.getCurrentTeamMember(teamId, userId);
    },
  };
}
