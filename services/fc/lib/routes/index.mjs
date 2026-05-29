import { registerAuth } from "./auth.mjs";
import { registerTeams } from "./teams.mjs";
import { registerSessions } from "./sessions.mjs";
import { registerMessages } from "./messages.mjs";
import { registerInvites } from "./invites.mjs";
import { registerWorkspaces } from "./workspaces.mjs";
import { registerSystem } from "./system.mjs";
import { registerActors } from "./actors.mjs";
import { registerNotifications } from "./notifications.mjs";
import { registerIdeas } from "./ideas.mjs";
import { registerShortcuts } from "./shortcuts.mjs";
import { registerRuntime } from "./runtime.mjs";
import { registerAttachments } from "./attachments.mjs";
import { registerTelemetry } from "./telemetry.mjs";
import { registerConfig } from "./config.mjs";
import { registerDirectory } from "./directory.mjs";
import { registerSync } from "./sync.mjs";
import { registerTeamShare } from "./team-share.mjs";
import { registerTeamLiteLlm } from "./team-litellm.mjs";

export function registerAllRoutes(router) {
  registerAuth(router);
  registerTeams(router);
  registerSessions(router);
  registerMessages(router);
  registerInvites(router);
  // team-share routes must be registered BEFORE workspaces so the new merged
  // GET /v1/teams/:teamId/workspace-config (share+litellm shape) wins over
  // the legacy default/pinned-workspace GET in workspaces.mjs. The legacy
  // PUT remains reachable since it's a distinct verb.
  registerTeamShare(router);
  registerTeamLiteLlm(router);
  registerWorkspaces(router);
  registerSystem(router);
  registerActors(router);
  registerNotifications(router);
  registerIdeas(router);
  registerShortcuts(router);
  registerRuntime(router);
  registerAttachments(router);
  registerTelemetry(router);
  registerConfig(router);
  registerDirectory(router);
  registerSync(router);
}

export { registerAuth, registerTeams, registerSessions, registerMessages, registerInvites, registerWorkspaces, registerSystem, registerActors, registerNotifications, registerIdeas, registerShortcuts, registerRuntime, registerAttachments, registerTelemetry, registerConfig };