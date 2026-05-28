import type { ActorDirectoryEntry, SessionMemberCandidate, SessionMembersBackend } from "../types";
import type { CloudApiClient } from "./http";

type CloudSessionParticipant = {
  sessionId: string;
  actorId: string;
  role?: string | null;
  joinedAt?: string | null;
  // enriched actor fields from FC (optional)
  displayName?: string | null;
  actorType?: string | null;
  teamId?: string | null;
};

function mapParticipant(row: CloudSessionParticipant): ActorDirectoryEntry {
  return {
    id: row.actorId,
    team_id: row.teamId ?? "",
    actor_type: row.actorType ?? null,
    display_name: row.displayName ?? null,
    avatar_url: null,
    user_id: null,
    team_role: row.role ?? null,
    member_status: null,
    agent_status: null,
    agent_types: null,
    default_agent_type: null,
    default_workspace_id: null,
    last_active_at: null,
    created_at: row.joinedAt ?? null,
    updated_at: null,
  };
}

export function createSessionMembersModule(client: CloudApiClient, delegate: SessionMembersBackend): SessionMembersBackend {
  return {
    ...delegate,
    async listParticipants(sessionId) {
      const out = await client.get<{ items: CloudSessionParticipant[] }>(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`);
      return out.items.map(mapParticipant);
    },
    async addParticipant(sessionId, actorId) {
      await client.post<CloudSessionParticipant>(`/v1/sessions/${encodeURIComponent(sessionId)}/participants`, { actorId, role: "member" });
    },
    async removeParticipant(sessionId, actorId) {
      await client.delete<void>(`/v1/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(actorId)}`);
    },
  };
}
