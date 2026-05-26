import { create } from "zustand";
import { supabase } from "@/lib/supabase-client";
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
    const { data, error } = await supabase
      .from("teams")
      .select("id, name, slug, created_at")
      .order("created_at", { ascending: true })
      .limit(1);

    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    const row = data?.[0];
    const activeTeam = row ? { id: row.id, name: row.name, slug: row.slug } : null;
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
    const { data, error } = await supabase
      .from("teams")
      .select("id, name, slug")
      .eq("id", teamId)
      .single();

    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    const activeTeam = data ? { id: data.id, name: data.name, slug: data.slug } : null;
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
  const { data: actorRows, error: actorError } = await supabase
    .from("actor_directory")
    .select("id, display_name, team_role")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .eq("actor_type", "member")
    .limit(1);

  if (actorError) {
    console.warn("[CurrentTeam] failed to load current member", actorError);
    return null;
  }

  const actor = actorRows?.[0] as
    | { id: string; display_name: string | null; team_role: string | null }
    | undefined;
  if (!actor) return null;

  const { data: memberRows, error: memberError } = await supabase
    .from("team_members")
    .select("joined_at")
    .eq("team_id", teamId)
    .eq("member_id", actor.id)
    .limit(1);

  if (memberError) {
    console.warn("[CurrentTeam] failed to load current member join time", memberError);
  }

  const membership = memberRows?.[0] as { joined_at: string | null } | undefined;
  return {
    id: actor.id,
    displayName: actor.display_name || "",
    role: actor.team_role,
    joinedAt: membership?.joined_at ?? null,
  };
}
