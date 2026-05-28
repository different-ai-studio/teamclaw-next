import { requireString, optionalStringOrNull } from "../router.mjs";

export function registerTeams(router) {
  router.get("/v1/teams", async (ctx) => {
    const items = await ctx.repository.listTeams({ limit: 50 });
    return { body: { items, nextCursor: null } };
  });

  router.post("/v1/teams", async (ctx) => {
    const body = ctx.json;
    requireString(body.name, "name");
    const team = await ctx.repository.createTeam({
      name: body.name,
      slug: optionalStringOrNull(body.slug, "slug"),
    });
    return { body: team };
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
    requireString(body.actorType, "actorType");
    requireString(body.displayName, "displayName");
    const result = await ctx.repository.createTeamInvite(ctx.params.teamId, {
      actorType: body.actorType,
      displayName: body.displayName,
      role: body.role,
      expiresAt: optionalStringOrNull(body.expiresAt, "expiresAt"),
    });
    return { statusCode: 201, body: result };
  });

  router.delete("/v1/teams/:teamId/members/:actorId", async (ctx) => {
    await ctx.repository.removeTeamActor(ctx.params.teamId, ctx.params.actorId);
    return { statusCode: 204 };
  });

  router.get("/v1/teams/:teamId/directory", async (ctx) => {
    const result = await ctx.repository.getTeamDirectory(ctx.params.teamId);
    return { body: result };
  });
}