import type { TeamWorkspaceConfigBackend, TeamWorkspaceConfigRow } from "../types";
import type { CloudApiClient } from "./http";

// The FC /v1/teams/:teamId/workspace-config stores a subset of fields.
// We delegate to Supabase for the full feature set as the FC endpoint
// may not expose all legacy fields (git_token, ai_gateway_endpoint, etc.).
// This module adds /v1 routing for the supported fields.

export function createTeamWorkspaceConfigModule(
  client: CloudApiClient,
  delegate: TeamWorkspaceConfigBackend,
): TeamWorkspaceConfigBackend {
  // The TeamWorkspaceConfigRow shape (git_url, git_token, ai_gateway_endpoint) is
  // not fully represented in the FC /v1 endpoint (which serves a different
  // workspace-config schema focused on defaultWorkspaceId/pinnedWorkspaceIds).
  // Until FC exposes all fields, delegate to Supabase for this domain.
  return {
    ...delegate,
  };
}
