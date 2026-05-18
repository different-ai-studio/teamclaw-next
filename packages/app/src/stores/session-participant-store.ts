import { create } from "zustand";
import {
  loadActorsByIds,
  loadSessionParticipants,
} from "@/lib/local-cache";
import { syncParticipantsForSession } from "@/lib/sync/session-participant-sync";

export type SessionParticipantInfo = {
  actorId: string;
  displayName: string;
  avatarUrl: string | null;
  isAgent: boolean;
};

type State = {
  participantsBySession: Record<string, SessionParticipantInfo[]>;
  loadingBySession: Record<string, boolean>;
  errorBySession: Record<string, string | null>;
  ensureParticipants: (sessionIds: string[]) => Promise<void>;
  refreshSession: (sessionId: string, teamId?: string | null) => Promise<void>;
  invalidateSessions: (sessionIds: string[]) => void;
};

async function loadParticipantInfo(sessionId: string): Promise<SessionParticipantInfo[]> {
  const parts = await loadSessionParticipants(sessionId);
  if (parts.length === 0) return [];
  const actorIds = parts.map((p) => p.actorId);
  const actors = await loadActorsByIds(actorIds);
  const byId = new Map(actors.map((a) => [a.id, a] as const));
  return parts
    .map((p) => {
      const actor = byId.get(p.actorId);
      if (!actor) return null;
      return {
        actorId: actor.id,
        displayName: actor.displayName,
        avatarUrl: actor.avatarUrl ?? null,
        isAgent: actor.actorType === "agent",
      };
    })
    .filter((p): p is SessionParticipantInfo => p !== null);
}

export const useSessionParticipantStore = create<State>((set, get) => ({
  participantsBySession: {},
  loadingBySession: {},
  errorBySession: {},
  ensureParticipants: async (sessionIds) => {
    const unique = Array.from(new Set(sessionIds)).filter(Boolean);
    const missing = unique.filter(
      (sessionId) =>
        get().participantsBySession[sessionId] === undefined &&
        !get().loadingBySession[sessionId],
    );
    if (missing.length === 0) return;

    set((state) => ({
      loadingBySession: {
        ...state.loadingBySession,
        ...Object.fromEntries(missing.map((sessionId) => [sessionId, true])),
      },
      errorBySession: {
        ...state.errorBySession,
        ...Object.fromEntries(missing.map((sessionId) => [sessionId, null])),
      },
    }));

    await Promise.all(
      missing.map(async (sessionId) => {
        try {
          const participants = await loadParticipantInfo(sessionId);
          set((state) => ({
            participantsBySession: {
              ...state.participantsBySession,
              [sessionId]: participants,
            },
            loadingBySession: {
              ...state.loadingBySession,
              [sessionId]: false,
            },
          }));
        } catch (error) {
          set((state) => ({
            loadingBySession: {
              ...state.loadingBySession,
              [sessionId]: false,
            },
            errorBySession: {
              ...state.errorBySession,
              [sessionId]: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      }),
    );
  },
  refreshSession: async (sessionId, teamId = null) => {
    if (teamId) {
      await syncParticipantsForSession(sessionId, teamId, { full: true });
    }
    get().invalidateSessions([sessionId]);
    await get().ensureParticipants([sessionId]);
  },
  invalidateSessions: (sessionIds) => {
    const ids = new Set(sessionIds);
    if (ids.size === 0) return;
    set((state) => {
      const participantsBySession = { ...state.participantsBySession };
      const errorBySession = { ...state.errorBySession };
      for (const sessionId of ids) {
        delete participantsBySession[sessionId];
        delete errorBySession[sessionId];
      }
      return { participantsBySession, errorBySession };
    });
  },
}));
