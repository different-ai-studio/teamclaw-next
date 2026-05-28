import type { AuthBackend, AuthSession, Unsubscribe } from "../types";
import { BackendError, toBackendError } from "../errors";
import { isTauri } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Session as SupabaseSession } from "@supabase/supabase-js";

type SupabaseAuthClient = {
  auth: {
    getSession(): Promise<{ data: { session: SupabaseSession | null }; error?: unknown }>;
    onAuthStateChange(
      listener: (event: string, session: SupabaseSession | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
    signInWithOtp(args: {
      email: string;
      options: { shouldCreateUser: boolean };
    }): Promise<{ error: unknown | null }>;
    verifyOtp(args: {
      email: string;
      token: string;
      type: "email" | "email_change";
    }): Promise<{ data: { session: SupabaseSession | null }; error: unknown | null }>;
    signInAnonymously(): Promise<{ data: { session: SupabaseSession | null }; error: unknown | null }>;
    signOut(): Promise<{ error: unknown | null }>;
    updateUser(args: { email: string }): Promise<{ data: unknown; error: unknown | null }>;
  };
  rpc(name: "claim_team_invite", args: { p_token: string }): Promise<{ data: unknown; error: unknown | null }>;
  rpc(name: "get_team_sync_mode", args: { p_team_id: string }): Promise<{ data: unknown; error: unknown | null }>;
};

type InviteClaimRow = {
  actor_id: string;
  team_id: string;
  actor_type: string;
  display_name: string;
  refresh_token?: string | null;
};

function mapSupabaseSession(session: SupabaseSession | null): AuthSession | null {
  if (!session) return null;
  return {
    user: {
      id: session.user.id,
      email: session.user.email ?? null,
      isAnonymous: (session.user as { is_anonymous?: boolean }).is_anonymous ?? false,
      providerData: session.user,
    },
    accessToken: session.access_token ?? null,
    refreshToken: session.refresh_token ?? null,
    expiresAt: session.expires_at ?? null,
    providerData: session,
  };
}

function mapInviteClaimRow(row: InviteClaimRow) {
  return {
    actorId: row.actor_id,
    teamId: row.team_id,
    actorType: row.actor_type,
    displayName: row.display_name,
    refreshToken: row.refresh_token ?? null,
  };
}

export function createSupabaseAuthBackend(client: unknown): AuthBackend {
  const supabase = client as SupabaseAuthClient;

  return {
    async getSession(): Promise<AuthSession | null> {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw toBackendError(error, "auth.getSession");
      return mapSupabaseSession(data.session);
    },
    onAuthStateChange(listener: (session: AuthSession | null) => void): Unsubscribe {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        listener(mapSupabaseSession(session));
      });
      return () => data.subscription.unsubscribe();
    },
    async sendOtp(email: string): Promise<void> {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw toBackendError(error, "auth.sendOtp");
    },
    async verifyOtp(email: string, code: string): Promise<AuthSession | null> {
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      });
      if (error) throw toBackendError(error, "auth.verifyOtp");
      return mapSupabaseSession(data.session);
    },
    async signInAnonymously(): Promise<AuthSession | null> {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw toBackendError(error, "auth.signInAnonymously");
      return mapSupabaseSession(data.session);
    },
    async signOut(): Promise<void> {
      const { error } = await supabase.auth.signOut();
      if (error) throw toBackendError(error, "auth.signOut");
    },
    async sendUpgradeEmailOtp(email: string): Promise<void> {
      const { error } = await supabase.auth.updateUser({ email });
      if (error) throw toBackendError(error, "auth.sendUpgradeEmailOtp");
    },
    async verifyUpgradeEmailOtp(email: string, code: string): Promise<AuthSession | null> {
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email_change",
      });
      if (error) throw toBackendError(error, "auth.verifyUpgradeEmailOtp");
      return mapSupabaseSession(data.session);
    },
    async claimInvite(token: string) {
      const { data, error } = await supabase.rpc("claim_team_invite", { p_token: token });
      if (error) throw toBackendError(error, "auth.claimInvite");
      const row = (Array.isArray(data) ? data[0] : data) as InviteClaimRow | null;
      if (!row) {
        throw new BackendError({
          category: "Unknown",
          operation: "auth.claimInvite",
          message: "Invite claim returned no team.",
        });
      }
      const claim = mapInviteClaimRow(row);

      // Tranche 5: auto-detect sync_mode after join and persist locally.
      // The 5-min tick will dispatch to the correct backend on next cycle.
      try {
        const { data: modeData } = await supabase.rpc("get_team_sync_mode", {
          p_team_id: claim.teamId,
        });
        const detected = typeof modeData === "string" ? modeData : null;
        if (detected && isTauri()) {
          const workspacePath = useWorkspaceStore.getState().workspacePath;
          if (workspacePath) {
            await invoke("oss_sync_set_local_sync_mode", {
              workspacePath,
              teamId: claim.teamId,
              mode: detected,
            });
          }
        }
      } catch (e) {
        console.warn("[claim-invite] failed to auto-detect sync_mode", e);
      }

      return claim;
    },
  };
}
