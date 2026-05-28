import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { useAuthStore } from "./auth-store";

async function setLocalCacheTeamGate(teamId: string | null): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("local_cache_set_current_team", { teamId });
  } catch (error) {
    // Non-fatal: browser preview or missing tauri runtime. The gate is a
    // defense-in-depth layer, not a correctness requirement.
    console.debug("[CurrentTeam] local_cache_set_current_team unavailable", error);
  }
}

export interface CurrentTeam {
  id: string;
  name: string;
  slug: string;
}

export interface CurrentTeamMember {
  id: string;
  displayName: string;
  role: string | null;
  joinedAt: string | null;
}

interface State {
  team: CurrentTeam | null;
  currentMember: CurrentTeamMember | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  reloadAndSwitchTo: (teamId: string) => Promise<void>;
  setActiveTeam: (team: CurrentTeam) => Promise<void>;
  rename: (newName: string) => Promise<boolean>;
}

export const useCurrentTeamStore = create<State>((set, get) => ({
  team: null,
  currentMember: null,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    const session = useAuthStore.getState().session;
    if (!session) {
      await setLocalCacheTeamGate(null);
      set({ team: null, currentMember: null, loading: false, error: null });
      return;
    }

    set({ loading: true, error: null });
    let row;
    try {
      row = (await getBackend().teams.listCurrentUserTeams({ limit: 1 }))[0];
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const activeTeam = row ? { id: row.id, name: row.name, slug: row.slug ?? "" } : null;
    await setLocalCacheTeamGate(activeTeam?.id ?? null);
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, session.user.id)
      : null;
    set({
      team: activeTeam,
      currentMember,
      loading: false,
    });
  },

  reloadAndSwitchTo: async (teamId: string) => {
    const session = useAuthStore.getState().session;
    if (!session) {
      await setLocalCacheTeamGate(null);
      set({ team: null, currentMember: null, loading: false, error: null });
      return;
    }

    // Gate must be moved BEFORE any local_cache_* call for the new team so the
    // backend accepts hydration loads for the team we're switching to.
    await setLocalCacheTeamGate(teamId);

    set({ loading: true, error: null });
    let data;
    try {
      data = await getBackend().teams.getTeam(teamId);
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const activeTeam = data ? { id: data.id, name: data.name, slug: data.slug ?? "" } : null;
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, session.user.id)
      : null;
    set({
      team: activeTeam,
      currentMember,
      loading: false,
    });
  },

  setActiveTeam: async (team) => {
    const session = useAuthStore.getState().session;
    await setLocalCacheTeamGate(team.id);
    const currentMember = session
      ? await loadCurrentMember(team.id, session.user.id)
      : null;
    set({ team, currentMember, loading: false, error: null });
  },

  rename: async (newName) => {
    const team = get().team;
    if (!team) {
      set({ error: "no current team" });
      return false;
    }
    const trimmed = newName.trim();
    if (!trimmed) {
      set({ error: "team name is required" });
      return false;
    }

    set({ saving: true, error: null });
    try {
      const renamed = await getBackend().teams.renameTeam(team.id, trimmed);
      set({
        team: {
          id: renamed.id || team.id,
          name: renamed.name || trimmed,
          slug: renamed.slug ?? team.slug,
        },
        saving: false,
      });
      return true;
    } catch (error) {
      set({
        saving: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },
}));

async function loadCurrentMember(teamId: string, userId: string): Promise<CurrentTeamMember | null> {
  try {
    return await getBackend().directory.getCurrentTeamMember(teamId, userId);
  } catch (error) {
    console.warn("[CurrentTeam] failed to load current member", error);
    return null;
  }
}
