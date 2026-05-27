import { registerTeams } from "./teams.mjs";
import { registerSessions } from "./sessions.mjs";
import { registerMessages } from "./messages.mjs";
import { registerInvites } from "./invites.mjs";

export function registerAllRoutes(router) {
  registerTeams(router);
  registerSessions(router);
  registerMessages(router);
  registerInvites(router);
}

export { registerTeams, registerSessions, registerMessages, registerInvites };