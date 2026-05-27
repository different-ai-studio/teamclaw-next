export function registerSystem(router) {
  router.post("/v1/heartbeat", async (ctx) => {
    await ctx.repository.heartbeat();
    return { statusCode: 204 };
  });
}