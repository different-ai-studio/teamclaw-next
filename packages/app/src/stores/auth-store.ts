import { create } from "zustand";
import type { OAuthProvider } from "@/lib/auth";
import {
  BACKEND_CONFIG_MISSING_MESSAGE,
  getBackend,
  hasBackendConfig,
} from "@/lib/backend";
import type { AuthClaimResult, AuthSession } from "@/lib/backend";
import { clearBootstrapAppliedFields, fetchAndApplyBootstrap } from "@/lib/bootstrap";
import { markStartup } from "@/lib/startup-perf";

export type { AuthClaimResult } from "@/lib/backend";

export type AuthFlow = "idle" | "invite";

type StoreAuthSession = AuthSession & {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
};

interface AuthState {
  session: StoreAuthSession | null;
  loading: boolean;
  // Dedicated flag for the post-authentication "upgrade account" flow. It must
  // stay SEPARATE from `loading`: AuthGate tears the whole app subtree down and
  // shows a splash whenever `loading` is true while a session exists, which
  // would unmount the upgrade dialog (and reset its open state) mid-request.
  upgradeLoading: boolean;
  authFlow: AuthFlow;
  errorMessage: string | null;
  otpEmail: string | null;
  otpPhone: string | null;
  upgradeEmail: string | null;
  hydrate: () => Promise<void>;
  sendOtp: (email: string) => Promise<boolean>;
  verifyOtp: (code: string) => Promise<void>;
  sendPhoneOtp: (phone: string) => Promise<boolean>;
  verifyPhoneOtp: (code: string) => Promise<void>;
  resetOtp: () => void;
  signInAnonymously: () => Promise<boolean>;
  signInWithOAuth: (provider: OAuthProvider) => Promise<boolean>;
  claimInvite: (token: string) => Promise<AuthClaimResult | null>;
  claimInviteAfterAnonymousSignIn: (token: string) => Promise<AuthClaimResult | null>;
  sendUpgradeEmailOtp: (email: string) => Promise<boolean>;
  verifyUpgradeEmailOtp: (code: string) => Promise<boolean>;
  resetUpgradeOtp: () => void;
  signOut: () => Promise<void>;
}

function errorMessageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Authentication failed.";
}

function storeSession(session: AuthSession | null): StoreAuthSession | null {
  if (!session) return null;
  return {
    ...session,
    access_token: session.accessToken ?? null,
    refresh_token: session.refreshToken ?? null,
    expires_at: session.expiresAt ?? null,
  };
}

async function claimInviteToken(token: string): Promise<AuthClaimResult | { errorMessage: string }> {
  try {
    return await getBackend().auth.claimInvite(token);
  } catch (error) {
    return { errorMessage: errorMessageFor(error) };
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  upgradeLoading: false,
  authFlow: "idle",
  errorMessage: null,
  otpEmail: null,
  otpPhone: null,
  upgradeEmail: null,
  hydrate: async () => {
    set({ loading: true, authFlow: "idle", errorMessage: null });
    markStartup("auth-hydrate:start");
    const session = await getBackend().auth.getSession();
    markStartup("auth-session:end");
    set({ session: storeSession(session), loading: false });
    if (session) {
      void fetchAndApplyBootstrap({ accessToken: session.accessToken });
    }
    getBackend().auth.onAuthStateChange((session) => {
      set({ session: storeSession(session) });
      if (session) {
        void fetchAndApplyBootstrap({ accessToken: session.accessToken });
      }
    });
  },
  sendOtp: async (email) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      await getBackend().auth.sendOtp(email);
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    set({ loading: false, otpEmail: email });
    return true;
  },
  verifyOtp: async (code) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return;
    }
    const email = get().otpEmail;
    if (!email) {
      set({ errorMessage: "No pending sign-in. Re-enter your email." });
      return;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      const session = await getBackend().auth.verifyOtp(email, code);
      set({ session: storeSession(session), loading: false, otpEmail: null });
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return;
    }
  },
  sendPhoneOtp: async (phone) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      await getBackend().auth.sendPhoneOtp(phone);
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    set({ loading: false, otpPhone: phone });
    return true;
  },
  verifyPhoneOtp: async (code) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return;
    }
    const phone = get().otpPhone;
    if (!phone) {
      set({ errorMessage: "No pending sign-in. Re-enter your phone number." });
      return;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      const session = await getBackend().auth.verifyPhoneOtp(phone, code);
      set({ session: storeSession(session), loading: false, otpPhone: null });
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return;
    }
  },
  resetOtp: () => set({ otpEmail: null, otpPhone: null, errorMessage: null }),
  signInAnonymously: async () => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      const session = await getBackend().auth.signInAnonymously();
      set({ session: storeSession(session), loading: false, otpEmail: null });
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    return true;
  },
  signInWithOAuth: async (provider) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    set({ loading: true, authFlow: "idle", errorMessage: null });
    try {
      const session = await getBackend().auth.signInWithOAuth(provider);
      set({ session: storeSession(session), loading: false, otpEmail: null });
    } catch (error) {
      set({ loading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    return true;
  },
  claimInvite: async (token) => {
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
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
    if (!hasBackendConfig()) {
      set({ loading: false, errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return null;
    }
    set({ loading: true, authFlow: "invite", errorMessage: null });
    let session: AuthSession | null;
    try {
      session = await getBackend().auth.signInAnonymously();
    } catch (error) {
      set({ loading: false, authFlow: "idle", errorMessage: errorMessageFor(error) });
      return null;
    }
    set({ session: storeSession(session), otpEmail: null });
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
  sendUpgradeEmailOtp: async (email) => {
    if (!hasBackendConfig()) {
      set({ errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    // Use `upgradeLoading`, never the global `loading` — see AuthState.
    set({ upgradeLoading: true, errorMessage: null });
    try {
      await getBackend().auth.sendUpgradeEmailOtp(email);
    } catch (error) {
      set({ upgradeLoading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    set({ upgradeLoading: false, upgradeEmail: email });
    return true;
  },
  verifyUpgradeEmailOtp: async (code) => {
    if (!hasBackendConfig()) {
      set({ errorMessage: BACKEND_CONFIG_MISSING_MESSAGE });
      return false;
    }
    const email = get().upgradeEmail;
    if (!email) {
      set({ errorMessage: "No pending upgrade. Re-enter your email." });
      return false;
    }
    // Use `upgradeLoading`, never the global `loading` — see AuthState.
    set({ upgradeLoading: true, errorMessage: null });
    try {
      const session = await getBackend().auth.verifyUpgradeEmailOtp(email, code);
      set({ session: storeSession(session), upgradeLoading: false, upgradeEmail: null });
    } catch (error) {
      set({ upgradeLoading: false, errorMessage: errorMessageFor(error) });
      return false;
    }
    return true;
  },
  resetUpgradeOtp: () => set({ upgradeEmail: null, upgradeLoading: false, errorMessage: null }),
  signOut: async () => {
    await getBackend().auth.signOut();
    set({ session: null, authFlow: "idle", otpEmail: null, otpPhone: null, upgradeEmail: null });
    // Reset the current team so the NEXT (e.g. anonymous) login doesn't inherit
    // the previous user's team. Without this the current-team store kept the old
    // team (its RLS-lag guard preserves it while the new user's team list is
    // momentarily empty), and AuthGate's `if (team) return` then skipped
    // switching — so team actions (e.g. enable OSS share) targeted the previous
    // user's already-locked team and failed with "share mode already locked".
    try {
      const { useCurrentTeamStore } = await import("@/stores/current-team");
      useCurrentTeamStore.setState({
        team: null,
        currentMember: null,
        loading: false,
        error: null,
      });
    } catch (error) {
      console.warn("[auth] reset current-team on signOut failed:", error);
    }
    try {
      const { useWorkspaceStore } = await import("@/stores/workspace");
      await useWorkspaceStore.getState().clearWorkspace();
    } catch (error) {
      console.warn("[auth] clearWorkspace on signOut failed:", error);
    }
    try {
      await clearBootstrapAppliedFields();
    } catch (error) {
      console.warn("[auth] clearBootstrapAppliedFields on signOut failed:", error);
    }
  },
}));
