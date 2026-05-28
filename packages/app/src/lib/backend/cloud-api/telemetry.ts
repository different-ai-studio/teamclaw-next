import type { TelemetryBackend, TelemetryFeedbackDeleteInput } from "../types";
import type { CloudApiClient } from "./http";

export function createTelemetryModule(client: CloudApiClient): TelemetryBackend {
  return {
    async insertFeedback(input) {
      await client.post<void>("/v1/telemetry/feedback", input);
    },
    async deleteFeedback(input: TelemetryFeedbackDeleteInput) {
      await client.post<void>("/v1/telemetry/feedback/delete", input);
    },
    async listFeedbacks(input) {
      const params = new URLSearchParams({ teamId: input.teamId, sessionId: input.sessionId });
      const out = await client.get<{ items: Array<Record<string, unknown>> }>(`/v1/telemetry/feedback?${params}`);
      return out.items;
    },
    async listFeedbackSummary(teamId) {
      const out = await client.get<{ items: Array<Record<string, unknown>> }>(`/v1/telemetry/feedback-summary?teamId=${encodeURIComponent(teamId)}`);
      return out.items;
    },
    async insertSessionReport(input) {
      await client.post<void>("/v1/telemetry/session-report", input);
    },
    async listLeaderboard(teamId) {
      const out = await client.get<{ items: Array<Record<string, unknown>> }>(`/v1/telemetry/leaderboard?teamId=${encodeURIComponent(teamId)}`);
      return out.items;
    },
  };
}
