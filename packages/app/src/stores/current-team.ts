import { create } from "zustand";
import { getBackend } from "@/lib/backend";
import { useAuthStore } from "./auth-store";
import {
  getTeamWorkspaceConfig,
  type TeamWorkspaceConfig,
} from "@/lib/team-workspace-config";

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
  activeWorkspaceConfig: TeamWorkspaceConfig | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  reloadAndSwitchTo: (teamId: string) => Promise<void>;
  rename: (newName: string) => Promise<boolean>;
}

export const useCurrentTeamStore = create<State>((set, get) => ({
  team: null,
  currentMember: null,
  activeWorkspaceConfig: null,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    const session = useAuthStore.getState().session;
    if (!session) {
      set({ team: null, currentMember: null, activeWorkspaceConfig: null, loading: false, error: null });
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
    const currentMember = activeTeam
      ? await loadCurrentMember(activeTeam.id, session.user.id)
      : null;
    const activeWorkspaceConfig = activeTeam
      ? await getTeamWorkspaceConfig(activeTeam.id)
      : null;
    set({
      team: activeTeam,
      currentMember,
      activeWorkspaceConfig,
      loading: false,
    });
  },

  reloadAndSwitchTo: async (teamId: string) => {
    const session = useAuthStore.getState().session;
    if (!session) {
      set({ team: null, currentMember: null, activeWorkspaceConfig: null, loading: false, error: null });
      return;
    }

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
    const activeWorkspaceConfig = activeTeam
      ? await getTeamWorkspaceConfig(activeTeam.id)
      : null;
    set({
      team: activeTeam,
      currentMember,
      activeWorkspaceConfig,
      loading: false,
    });
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
