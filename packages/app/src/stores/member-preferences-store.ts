import { create } from "zustand";
import { getBackend } from "@/lib/backend";

/**
 * Per-(current user) preferences that live on the member row, scoped to a team.
 *
 * Right now this holds only the member's default agent — the agent pre-selected
 * when starting a session, pinned to the top of the "Recents" sidebar list, and
 * shown as the default in the iOS actor detail. It is keyed by team because a
 * user is a distinct member in each of their teams.
 */
interface MemberPreferencesState {
  /** Team the cached `defaultAgentId` belongs to. */
  teamId: string | null;
  defaultAgentId: string | null;
  loading: boolean;
  /** Load (once per team) the caller's default agent. Cheap no-op if already loaded. */
  ensureLoaded: (teamId: string) => Promise<void>;
  /** Force a re-fetch for the given team. */
  reload: (teamId: string) => Promise<void>;
  /**
   * Set (agentId) or clear (null) the caller's default agent. Optimistically
   * updates local state, then reconciles with the server response. Throws on
   * failure (caller decides whether to surface it).
   */
  setDefaultAgent: (teamId: string, agentId: string | null) => Promise<void>;
}

export const useMemberPreferencesStore = create<MemberPreferencesState>((set, get) => ({
  teamId: null,
  defaultAgentId: null,
  loading: false,

  ensureLoaded: async (teamId) => {
    const state = get();
    if (state.teamId === teamId && !state.loading) return;
    await get().reload(teamId);
  },

  reload: async (teamId) => {
    set({ loading: true, teamId });
    try {
      const defaultAgentId = await getBackend().actors.getMemberDefaultAgent(teamId);
      // Guard against a team switch racing an in-flight fetch.
      if (get().teamId !== teamId) return;
      set({ defaultAgentId: defaultAgentId ?? null, loading: false });
    } catch (error) {
      console.warn("[MemberPreferences] failed to load default agent", error);
      if (get().teamId === teamId) set({ loading: false });
    }
  },

  setDefaultAgent: async (teamId, agentId) => {
    const prev = get().defaultAgentId;
    // Optimistic update for snappy UI.
    set({ teamId, defaultAgentId: agentId });
    try {
      const confirmed = await getBackend().actors.setMemberDefaultAgent(teamId, agentId);
      if (get().teamId === teamId) set({ defaultAgentId: confirmed ?? null });
    } catch (error) {
      // Roll back the optimistic change.
      if (get().teamId === teamId) set({ defaultAgentId: prev });
      throw error;
    }
  },
}));
