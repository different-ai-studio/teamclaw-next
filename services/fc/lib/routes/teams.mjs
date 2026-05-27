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
}