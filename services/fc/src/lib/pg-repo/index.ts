import type { PgDatabase } from "drizzle-orm/pg-core";
import { makeTeamsRepo } from "./teams.js";
import { makeIdeasRepo } from "./ideas.js";
import { makeSessionsRepo } from "./sessions.js";
import { makeMessagesRepo } from "./messages.js";
import { makeWorkspacesRepo } from "./workspaces.js";

const NI = (name: string) => async () => { throw new Error(`not_implemented:${name}`); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPgBusinessRepository({ db, accessToken, userId }: { db: PgDatabase<any, any>; accessToken?: string; userId?: string }) {
  void accessToken; // retained for Plan 4/5 (JWT -> actor identity / authz)
  const ctx = { userId };
  const teamsRepo = makeTeamsRepo(db);
  const ideasRepo = makeIdeasRepo(db, ctx);
  const sessionsRepo = makeSessionsRepo(db, ctx);
  const messagesRepo = makeMessagesRepo(db);
  const workspacesRepo = makeWorkspacesRepo(db);
  return {
    ...teamsRepo,
    ...ideasRepo,
    ...sessionsRepo,
    ...messagesRepo,
    // workspacesRepo methods shadow teamsRepo.getTeamWorkspaceConfig / putTeamWorkspaceConfig
    // with the contract-shape-returning implementations
    ...workspacesRepo,
    createTeam: NI("createTeam"),
    createTeamInvite: NI("createTeamInvite"),
    removeTeamActor: NI("removeTeamActor"),
    updateCurrentActorProfile: NI("updateCurrentActorProfile"),
    setupLiteLlm: NI("setupLiteLlm"),
    listTeamActors: NI("listTeamActors"),
    getTeamDirectory: NI("getTeamDirectory"),
  } as any;
}
