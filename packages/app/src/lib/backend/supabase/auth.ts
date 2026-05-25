import type { AuthBackend, AuthSession, Unsubscribe } from "../types";
import { BackendError, toBackendError } from "../errors";
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
      type: "email";
    }): Promise<{ data: { session: SupabaseSession | null }; error: unknown | null }>;
    signInAnonymously(): Promise<{ data: { session: SupabaseSession | null }; error: unknown | null }>;
    signOut(): Promise<{ error: unknown | null }>;
  };
  rpc(name: "claim_team_invite", args: { p_token: string }): Promise<{ data: unknown; error: unknown | null }>;
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
      return mapInviteClaimRow(row);
    },
  };
}
