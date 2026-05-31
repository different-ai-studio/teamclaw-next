import type { PgDatabase } from "drizzle-orm/pg-core";
import { makeTeamsRepo } from "./teams.js";

const NI = (name: string) => async () => { throw new Error(`not_implemented:${name}`); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPgBusinessRepository({ db, accessToken }: { db: PgDatabase<any, any>; accessToken?: string }) {
  void accessToken; // retained for Plan 4/5 (JWT -> actor identity / authz)
  const teamsRepo = makeTeamsRepo(db);
  return {
    ...teamsRepo,
    createTeam: NI("createTeam"),
    createTeamInvite: NI("createTeamInvite"),
    removeTeamActor: NI("removeTeamActor"),
    updateCurrentActorProfile: NI("updateCurrentActorProfile"),
    setupLiteLlm: NI("setupLiteLlm"),
    listTeamActors: NI("listTeamActors"),
    getTeamDirectory: NI("getTeamDirectory"),
  } as any;
}
