import { registerAuth } from "./auth.mjs";
import { registerTeams } from "./teams.mjs";
import { registerSessions } from "./sessions.mjs";
import { registerMessages } from "./messages.mjs";
import { registerInvites } from "./invites.mjs";
import { registerWorkspaces } from "./workspaces.mjs";
import { registerSystem } from "./system.mjs";
import { registerActors } from "./actors.mjs";
import { registerNotifications } from "./notifications.mjs";

export function registerAllRoutes(router) {
  registerAuth(router);
  registerTeams(router);
  registerSessions(router);
  registerMessages(router);
  registerInvites(router);
  registerWorkspaces(router);
  registerSystem(router);
  registerActors(router);
  registerNotifications(router);
}

export { registerAuth, registerTeams, registerSessions, registerMessages, registerInvites, registerWorkspaces, registerSystem, registerActors, registerNotifications };