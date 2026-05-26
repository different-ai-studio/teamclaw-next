import { supabase } from "./client";
import { createSupabaseActorsBackend } from "./actors";
import { createSupabaseAttachmentsBackend } from "./attachments";
import { createSupabaseAuthBackend } from "./auth";
import { createSupabaseDirectoryBackend } from "./directory";
import { createSupabaseIdeasBackend } from "./ideas";
import { createSupabaseMessagesBackend } from "./messages";
import { createSupabaseNotificationsBackend } from "./notifications";
import { createSupabaseRuntimeBackend } from "./runtime";
import { createSupabaseSessionMembersBackend } from "./session-members";
import { createSupabaseSessionsBackend } from "./sessions";
import { createSupabaseShortcutsBackend } from "./shortcuts";
import { createSupabaseTeamWorkspaceConfigBackend } from "./team-workspace-config";
import { createSupabaseTeamsBackend } from "./teams";
import { createSupabaseTelemetryBackend } from "./telemetry";
import { createSupabaseWorkspacesBackend } from "./workspaces";
import { createSupabaseSyncBackend } from "./sync";
import type { TeamClawBackend } from "../types";

export function createSupabaseBackend(): TeamClawBackend {
  return {
    kind: "supabase",
    auth: createSupabaseAuthBackend(supabase),
    directory: createSupabaseDirectoryBackend(supabase),
    sessions: createSupabaseSessionsBackend(supabase),
    messages: createSupabaseMessagesBackend(supabase),
    runtime: createSupabaseRuntimeBackend(supabase),
    attachments: createSupabaseAttachmentsBackend(supabase),
    teams: createSupabaseTeamsBackend(supabase),
    ideas: createSupabaseIdeasBackend(supabase),
    actors: createSupabaseActorsBackend(supabase),
    sessionMembers: createSupabaseSessionMembersBackend(supabase),
    shortcuts: createSupabaseShortcutsBackend(supabase),
    notifications: createSupabaseNotificationsBackend(supabase),
    teamWorkspaceConfig: createSupabaseTeamWorkspaceConfigBackend(supabase),
    workspaces: createSupabaseWorkspacesBackend(supabase),
    sync: createSupabaseSyncBackend(supabase),
    telemetry: createSupabaseTelemetryBackend(supabase),
  };
}
