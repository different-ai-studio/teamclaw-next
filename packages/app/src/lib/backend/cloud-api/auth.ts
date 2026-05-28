import type { AuthBackend, AuthClaimResult, AuthSession, Unsubscribe } from "../types";
import { BackendError } from "../errors";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import type { CloudApiClient } from "./http";
import {
  createAuthClient,
  getSession as getStoreSession,
  subscribe as subscribeStore,
  type AuthClient,
  type Session,
} from "@/lib/auth";

function mapSession(session: Session | null): AuthSession | null {
  if (!session) return null;
  const user = session.user;
  return {
    user: {
      id: user.id,
      email: user.email ?? null,
      isAnonymous: Boolean((user as { is_anonymous?: boolean }).is_anonymous),
      providerData: user,
    },
    accessToken: session.access_token ?? null,
    refreshToken: session.refresh_token ?? null,
    expiresAt: session.expires_at ?? null,
    providerData: session,
  };
}

export function createAuthModule(
  client: CloudApiClient,
  authClient: AuthClient,
): AuthBackend {
  return {
    async getSession(): Promise<AuthSession | null> {
      return mapSession(getStoreSession());
    },
    onAuthStateChange(listener: (session: AuthSession | null) => void): Unsubscribe {
      return subscribeStore((_event, session) => listener(mapSession(session)));
    },
    async sendOtp(email: string): Promise<void> {
      await authClient.sendOtp(email, { shouldCreateUser: true });
    },
    async verifyOtp(email: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.verifyOtp(email, code, "email");
      return mapSession(next);
    },
    async signInAnonymously(): Promise<AuthSession | null> {
      const next = await authClient.signInAnonymously();
      return mapSession(next);
    },
    async signOut(): Promise<void> {
      await authClient.signOut();
    },
    async sendUpgradeEmailOtp(email: string): Promise<void> {
      await authClient.updateUser({ email });
    },
    async verifyUpgradeEmailOtp(email: string, code: string): Promise<AuthSession | null> {
      const next = await authClient.verifyOtp(email, code, "email_change");
      return mapSession(next);
    },
    async claimInvite(token: string): Promise<AuthClaimResult> {
      const claim = await client.post<AuthClaimResult>("/v1/invites/claim", { token });
      if (!claim) {
        throw new BackendError({
          category: "Unknown",
          operation: "auth.claimInvite",
          message: "Invite claim returned no team.",
        });
      }
      // Auto-detect sync mode after join and persist locally (best-effort).
      try {
        if (isTauri()) {
          const workspacePath = useWorkspaceStore.getState().workspacePath;
          if (workspacePath) {
            // FC endpoint returns the team's syncMode in the claim payload if
            // available. Fall back to "p2p" when unspecified.
            const mode = (claim as { syncMode?: string | null }).syncMode ?? null;
            if (mode) {
              await invoke("oss_sync_set_local_sync_mode", {
                workspacePath,
                teamId: claim.teamId,
                mode,
              });
            }
          }
        }
      } catch (e) {
        console.warn("[claim-invite] failed to persist sync_mode", e);
      }
      return claim;
    },
  };
}

export { createAuthClient };
