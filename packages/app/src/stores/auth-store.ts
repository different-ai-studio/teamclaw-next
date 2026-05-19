import { create } from "zustand";
import {
  hasSupabaseConfig,
  SUPABASE_CONFIG_MISSING_MESSAGE,
  supabase,
} from "@/lib/supabase-client";
import type { Session } from "@supabase/supabase-js";

export interface AuthClaimResult {
  actorId: string;
  teamId: string;
  actorType: string;
  displayName: string;
  refreshToken: string | null;
}

export type AuthFlow = "idle" | "invite";

interface AuthClaimRow {
  actor_id: string;
  team_id: string;
  actor_type: string;
  display_name: string;
  refresh_token?: string | null;
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  authFlow: AuthFlow;
  errorMessage: string | null;
  otpEmail: string | null;
  hydrate: () => Promise<void>;
  sendOtp: (email: string) => Promise<boolean>;
  verifyOtp: (code: string) => Promise<void>;
  resetOtp: () => void;
  signInAnonymously: () => Promise<boolean>;
  claimInvite: (token: string) => Promise<AuthClaimResult | null>;
  claimInviteAfterAnonymousSignIn: (token: string) => Promise<AuthClaimResult | null>;
  signOut: () => Promise<void>;
}

function mapClaimResult(row: AuthClaimRow): AuthClaimResult {
  return {
    actorId: row.actor_id,
    teamId: row.team_id,
    actorType: row.actor_type,
    displayName: row.display_name,
    refreshToken: row.refresh_token ?? null,
  };
}

async function claimInviteToken(token: string): Promise<AuthClaimResult | { errorMessage: string }> {
  const { data, error } = await supabase.rpc("claim_team_invite", { p_token: token });
  if (error) return { errorMessage: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as AuthClaimRow | null;
  if (!row) return { errorMessage: "Invite claim returned no team." };
  return mapClaimResult(row);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  authFlow: "idle",
  errorMessage: null,
  otpEmail: null,
  hydrate: async () => {
    set({ loading: true, authFlow: "idle", errorMessage: null });
    const { data } = await supabase.auth.getSession();
    set({ session: data.session, loading: false });
    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session });
    });
  },
  sendOtp: async (email) => {
    if (!hasSupabaseConfig) {
      set({ loading: false, errorMessage: SUPABASE_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) {
      set({ loading: false, errorMessage: error.message });
      return false;
    }
    set({ loading: false, otpEmail: email });
    return true;
  },
  verifyOtp: async (code) => {
    if (!hasSupabaseConfig) {
      set({ loading: false, errorMessage: SUPABASE_CONFIG_MISSING_MESSAGE });
      return;
    }
    const email = get().otpEmail;
    if (!email) {
      set({ errorMessage: "No pending sign-in. Re-enter your email." });
      return;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error) {
      set({ loading: false, errorMessage: error.message });
      return;
    }
    set({ session: data.session, loading: false, otpEmail: null });
  },
  resetOtp: () => set({ otpEmail: null, errorMessage: null }),
  signInAnonymously: async () => {
    if (!hasSupabaseConfig) {
      set({ loading: false, errorMessage: SUPABASE_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) {
      set({ loading: false, errorMessage: error.message });
      return false;
    }
    set({ session: data.session, loading: false, otpEmail: null });
    return true;
  },
  claimInvite: async (token) => {
    if (!hasSupabaseConfig) {
      set({ loading: false, errorMessage: SUPABASE_CONFIG_MISSING_MESSAGE });
      return null;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    const result = await claimInviteToken(token);
    if ("errorMessage" in result) {
      set({ loading: false, errorMessage: result.errorMessage });
      return null;
    }
    set({ loading: false });
    return result;
  },
  claimInviteAfterAnonymousSignIn: async (token) => {
    if (!hasSupabaseConfig) {
      set({ loading: false, errorMessage: SUPABASE_CONFIG_MISSING_MESSAGE });
      return null;
    }
    set({ loading: true, authFlow: "invite", errorMessage: null });
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) {
      set({ loading: false, authFlow: "idle", errorMessage: error.message });
      return null;
    }
    set({ session: data.session, otpEmail: null });
    const result = await claimInviteToken(token);
    if ("errorMessage" in result) {
      set({ errorMessage: result.errorMessage });
      await get().signOut();
      set({ loading: false, authFlow: "idle" });
      return null;
    }
    const { useCurrentTeamStore } = await import("@/stores/current-team");
    await useCurrentTeamStore.getState().reloadAndSwitchTo(result.teamId);
    set({ loading: false, authFlow: "idle" });
    return result;
  },
  signOut: async () => {
    await supabase.auth.signOut();
    set({ session: null, authFlow: "idle", otpEmail: null });
  },
}));
