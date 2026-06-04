import type { PgDatabase } from "drizzle-orm/pg-core";
import { makeTeamsRepo, type TeamsRepoDeps } from "./teams.js";
import { makeIdeasRepo } from "./ideas.js";
import { makeSessionsRepo } from "./sessions.js";
import { makeMessagesRepo, type MessagesRepoDeps } from "./messages.js";
import { makeWorkspacesRepo } from "./workspaces.js";
import { makeShortcutsRepo } from "./shortcuts.js";
import { makeActorsRepo } from "./actors.js";
import { makeAgentsRepo } from "./agents.js";
import { makeRuntimeRepo } from "./runtime.js";
import { makeNotificationsRepo } from "./notifications.js";
import { makeTelemetryRepo } from "./telemetry.js";
import { makeAttachmentsRepo } from "./attachments.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPgBusinessRepository({ db, accessToken, userId, callerActorId, provisionLiteLlm, dispatchPush }: { db: PgDatabase<any, any>; accessToken?: string; userId?: string; callerActorId?: string; provisionLiteLlm?: TeamsRepoDeps["provisionLiteLlm"]; dispatchPush?: MessagesRepoDeps["dispatchPush"] }) {
  // accessToken is verified upstream (makeBusinessRepoFactory) and its `sub`
  // claim is passed here as `userId`. It is kept in the signature only for the
  // few methods that need to forward the raw bearer (none currently); identity
  // for authz flows exclusively through ctx.userId.
  void accessToken;
  const ctx = { userId, callerActorId };
  const teamsRepo = makeTeamsRepo(db, { provisionLiteLlm }, { userId });
  const teamsCtx = { userId };
  const ideasRepo = makeIdeasRepo(db, ctx);
  const sessionsRepo = makeSessionsRepo(db, ctx);
  // dispatchPush's helper RPCs (push_idempotency_claim, list_session_push_targets)
  // still use the Supabase service-role client — documented follow-up to migrate
  // those RPCs to pg-repo once the push domain is ported.
  const messagesRepo = makeMessagesRepo(db, { dispatchPush });
  const workspacesRepo = makeWorkspacesRepo(db);
  const shortcutsRepo = makeShortcutsRepo(db, ctx);
  const actorsRepo = makeActorsRepo(db, ctx);
  const agentsRepo = makeAgentsRepo(db, ctx);
  const runtimeRepo = makeRuntimeRepo(db);
  const notificationsRepo = makeNotificationsRepo(db, ctx);
  const telemetryRepo = makeTelemetryRepo(db, ctx);
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
    ...telemetryRepo,
    ...makeAttachmentsRepo(),
    createTeam: (input: any) => teamsRepo.createTeam(input, teamsCtx),
    createTeamInvite: (teamId: string, input: any) => teamsRepo.createTeamInvite(teamId, input, teamsCtx),
    removeTeamActor: (teamId: string, actorId: string) => teamsRepo.removeTeamActor(teamId, actorId),
  } as any;
}
