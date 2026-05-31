export function registerTeamLiteLlm(router) {
  router.post("/v1/teams/:teamId/litellm/setup", async (ctx) => {
    const result = await ctx.repository.setupLiteLlm(ctx.params.teamId);
    return { body: result };
  });
}
