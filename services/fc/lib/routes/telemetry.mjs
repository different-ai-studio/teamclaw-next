import { ApiError } from "../http-utils.mjs";
import { requireString } from "../router.mjs";

const VALID_KINDS = new Set(["up", "down", "star"]);
const VALID_PERIODS = new Set(["day", "week", "month"]);

export function registerTelemetry(router) {
  router.post("/v1/feedback", async (ctx) => {
    const body = ctx.json ?? {};
    requireString(body.messageId, "messageId");
    requireString(body.actorId, "actorId");
    requireString(body.kind, "kind");
    if (!VALID_KINDS.has(body.kind)) {
      throw new ApiError(400, "validation_failed", "kind must be one of: up, down, star");
    }
    if (body.starRating !== undefined && body.starRating !== null) {
      const r = Number(body.starRating);
      if (!Number.isInteger(r) || r < 1 || r > 5) {
        throw new ApiError(400, "validation_failed", "starRating must be an integer from 1 to 5");
      }
    }
    const feedback = await ctx.repository.submitFeedback(body);
    return { statusCode: 201, body: feedback };
  });

  router.get("/v1/feedback", async (ctx) => {
    const sessionId = ctx.query.get("sessionId");
    if (!sessionId) throw new ApiError(400, "validation_failed", "sessionId is required");
    const result = await ctx.repository.listFeedback({ sessionId });
    return { body: result };
  });

  router.delete("/v1/feedback/:messageId", async (ctx) => {
    const messageId = decodeURIComponent(ctx.params.messageId);
    await ctx.repository.deleteFeedback(messageId, null);
    return { statusCode: 204, body: null };
  });

  router.get("/v1/teams/:teamId/leaderboard", async (ctx) => {
    const teamId = decodeURIComponent(ctx.params.teamId);
    const period = ctx.query.get("period") ?? "week";
    if (!VALID_PERIODS.has(period)) {
      throw new ApiError(400, "validation_failed", "period must be one of: day, week, month");
    }
    const result = await ctx.repository.getTeamLeaderboard(teamId, { period });
    return { body: result };
  });
}
