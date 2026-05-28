import type { AuthBackend, AuthClaimResult } from "../types";
import type { CloudApiClient } from "./http";

export function createAuthModule(client: CloudApiClient, delegate: AuthBackend): AuthBackend {
  return {
    ...delegate,
    async claimInvite(token: string): Promise<AuthClaimResult> {
      return client.post<AuthClaimResult>("/v1/invites/claim", { token });
    },
  };
}
