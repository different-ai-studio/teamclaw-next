import type { PgDatabase } from "drizzle-orm/pg-core";
import { makeTeamsRepo } from "./teams.js";
import { makeIdeasRepo } from "./ideas.js";
import { makeSessionsRepo } from "./sessions.js";
import { makeMessagesRepo } from "./messages.js";
import { makeWorkspacesRepo } from "./workspaces.js";
import { makeShortcutsRepo } from "./shortcuts.js";
import { makeActorsRepo } from "./actors.js";
import { makeAgentsRepo } from "./agents.js";
import { makeRuntimeRepo } from "./runtime.js";
import { makeNotificationsRepo } from "./notifications.js";

const NI = (name: string) => async () => { throw new Error(`not_implemented:${name}`); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPgBusinessRepository({ db, accessToken, userId, callerActorId }: { db: PgDatabase<any, any>; accessToken?: string; userId?: string; callerActorId?: string }) {
  void accessToken; // retained for Plan 4/5 (JWT -> actor identity / authz)
  const ctx = { userId, callerActorId };
  const teamsRepo = makeTeamsRepo(db);
  const ideasRepo = makeIdeasRepo(db, ctx);
  const sessionsRepo = makeSessionsRepo(db, ctx);
  const messagesRepo = makeMessagesRepo(db);
  const workspacesRepo = makeWorkspacesRepo(db);
  const shortcutsRepo = makeShortcutsRepo(db, ctx);
  const actorsRepo = makeActorsRepo(db, ctx);
  const agentsRepo = makeAgentsRepo(db, ctx);
  const runtimeRepo = makeRuntimeRepo(db);
  const notificationsRepo = makeNotificationsRepo(db, ctx);
  return {
    ...teamsRepo,
    ...ideasRepo,
    ...sessionsRepo,
    ...messagesRepo,
    // workspacesRepo methods shadow teamsRepo.getTeamWorkspaceConfig / putTeamWorkspaceConfig
    // with the contract-shape-returning implementations
    ...workspacesRepo,
    ...shortcutsRepo,
    ...actorsRepo,
    ...agentsRepo,
    ...runtimeRepo,
    ...notificationsRepo,
    createTeam: NI("createTeam"),
    createTeamInvite: NI("createTeamInvite"),
    removeTeamActor: NI("removeTeamActor"),
    updateCurrentActorProfile: NI("updateCurrentActorProfile"),
    setupLiteLlm: NI("setupLiteLlm"),
  } as any;
}
