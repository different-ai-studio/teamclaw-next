import { requireString, optionalStringOrNull } from "../router.mjs";

export function registerTeams(router) {
  router.get("/v1/teams", async (ctx) => {
    const items = await ctx.repository.listTeams({ limit: 50 });
    return { body: { items, nextCursor: null } };
  });

  // POST /v1/teams — slim team creation (Task 3 of share-onboarding refactor).
  //
  // LiteLLM provisioning is now an explicit second step that the client
  // triggers via POST /v1/teams/:teamId/litellm/setup. This route only writes
  // the teams row + the bare team_workspace_config row (sync_mode=NULL,
  // litellm_team_id=NULL). The response still includes aiGatewayEndpoint and
  // litellmKey as null fields for back-compat with the Rust client
  // (`Option<String>` — see apps/desktop/src/commands/oss_sync/fc_client.rs).
  router.post("/v1/teams", async (ctx) => {
    const body = ctx.json;
    requireString(body.name, "name");

    const team = await ctx.repository.createTeam({
      name: body.name,
      slug: optionalStringOrNull(body.slug, "slug"),
      litellmTeamId: null,
      aiGatewayEndpoint: null,
    });

    return {
      body: {
        ...team,
        aiGatewayEndpoint: null,
        litellmKey: null,
      },
    };
  });

  router.get("/v1/teams/:id", async (ctx) => {
    const team = await ctx.repository.getTeam(decodeURIComponent(ctx.params.id));
    return { body: team };
  });

  router.patch("/v1/teams/:teamId", async (ctx) => {
    const body = ctx.json;
    requireString(body.name, "name");
    const team = await ctx.repository.renameTeam(ctx.params.teamId, { name: body.name });
    return { body: team };
  });

  router.post("/v1/teams/:teamId/invites", async (ctx) => {
    const body = ctx.json;
    const kind = body.kind ?? body.actorType;
    requireString(kind, "kind");
    requireString(body.displayName, "displayName");
    const result = await ctx.repository.createTeamInvite(ctx.params.teamId, {
      kind,
      displayName: body.displayName,
      teamRole: body.teamRole ?? body.role ?? null,
      agentKind: body.agentKind ?? null,
      ttlSeconds: body.ttlSeconds ?? null,
      targetActorId: body.targetActorId ?? null,
    });
    return { statusCode: 201, body: result };
  });

  router.delete("/v1/teams/:teamId/members/:actorId", async (ctx) => {
    await ctx.repository.removeTeamActor(ctx.params.teamId, ctx.params.actorId);
    return { statusCode: 204 };
  });

  // OpenAPI removeTeamActorScoped: clients (cloud-api/teams.ts) call the
  // /actors/ path. Same operation as /members/ above — register both so the
  // route resolves instead of returning "Route not found".
  router.delete("/v1/teams/:teamId/actors/:actorId", async (ctx) => {
    await ctx.repository.removeTeamActor(ctx.params.teamId, ctx.params.actorId);
    return { statusCode: 204 };
  });

  router.get("/v1/teams/:teamId/directory", async (ctx) => {
    const result = await ctx.repository.getTeamDirectory(ctx.params.teamId);
    return { body: result };
  });
}