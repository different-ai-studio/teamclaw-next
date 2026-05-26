import type { TelemetryBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";

type QueryResult<T = unknown> = Promise<{ data: T; error: unknown | null }>;

type SupabaseTelemetryClient = {
  from(table: string): {
    insert(row: Record<string, unknown>): Promise<{ error: unknown | null }>;
    select(columns: string): unknown;
    delete(): unknown;
  };
};

async function insertRow(
  supabase: SupabaseTelemetryClient,
  table: string,
  input: Record<string, unknown>,
  operation: string,
): Promise<void> {
  const { error } = await supabase.from(table).insert(input);
  if (error) throw toBackendError(error, operation);
}

function requireFeedbackDeleteFilters(input: {
  actor_id?: string;
  team_id?: string;
  message_id?: string;
  kind?: string;
}): void {
  for (const key of ["actor_id", "team_id", "message_id"] as const) {
    if (typeof input[key] !== "string" || input[key].trim() === "") {
      throw toBackendError({ message: `telemetry.deleteFeedback missing ${key}` }, "telemetry.deleteFeedback");
    }
  }
  if (input.kind !== "thumb" && input.kind !== "star") {
    throw toBackendError({ message: "telemetry.deleteFeedback missing delete kind" }, "telemetry.deleteFeedback");
  }
}

export function createSupabaseTelemetryBackend(client: unknown = defaultSupabase): TelemetryBackend {
  const supabase = client as SupabaseTelemetryClient;

  return {
    async insertFeedback(input) {
      await insertRow(supabase, "actor_message_feedback", input, "telemetry.insertFeedback");
    },
    async deleteFeedback(input) {
      requireFeedbackDeleteFilters(input);
      let query = supabase.from("actor_message_feedback").delete() as {
        eq(column: string, value: unknown): unknown;
        is?(column: string, value: unknown): unknown;
        not?(column: string, operator: string, value: unknown): unknown;
      };

      query = query.eq("actor_id", input.actor_id) as typeof query;
      query = query.eq("team_id", input.team_id) as typeof query;
      query = query.eq("message_id", input.message_id) as typeof query;

      if (input.kind === "thumb") {
        if (typeof query.is !== "function") {
          throw toBackendError(
            { message: "telemetry.deleteFeedback requires an is predicate for thumb deletes" },
            "telemetry.deleteFeedback",
          );
        }
        const is = query.is as NonNullable<typeof query.is>;
        query = is("star_rating", null) as typeof query;
      }

      if (input.kind === "star" && typeof query.not !== "function") {
        throw toBackendError(
          { message: "telemetry.deleteFeedback requires a not predicate for star-rating deletes" },
          "telemetry.deleteFeedback",
        );
      }
      if (input.kind === "star") {
        const not = query.not as NonNullable<typeof query.not>;
        query = not("star_rating", "is", null) as typeof query;
      }

      const { error } = (await query) as unknown as { error: unknown | null };
      if (error) throw toBackendError(error, "telemetry.deleteFeedback");
    },
    async listFeedbacks(input) {
      const query = supabase.from("actor_message_feedback").select("message_id, kind, star_rating") as {
        eq(column: string, value: unknown): unknown;
      };
      const teamQuery = query.eq("team_id", input.teamId) as typeof query;
      const { data, error } = (await teamQuery.eq("session_id", input.sessionId)) as Awaited<
        QueryResult<Array<Record<string, unknown>>>
      >;
      if (error) throw toBackendError(error, "telemetry.listFeedbacks");
      return data ?? [];
    },
    async listFeedbackSummary(teamId) {
      const query = supabase
        .from("team_leaderboard")
        .select("actor_id, display_name, positive_feedback_30d, negative_feedback_30d") as {
        eq(column: string, value: unknown): QueryResult<Array<Record<string, unknown>>>;
      };
      const { data, error } = await query.eq("team_id", teamId);
      if (error) throw toBackendError(error, "telemetry.listFeedbackSummary");
      return data ?? [];
    },
    async insertSessionReport(input) {
      await insertRow(supabase, "actor_session_report", input, "telemetry.insertSessionReport");
    },
    async listLeaderboard(teamId) {
      const query = supabase
        .from("team_leaderboard")
        .select("actor_id, display_name, tokens_used_30d, cost_usd_30d, positive_feedback_30d, negative_feedback_30d") as {
        eq(column: string, value: unknown): {
          order(column: string, options: { ascending: boolean }): QueryResult<Array<Record<string, unknown>>>;
        };
      };
      const { data, error } = await query.eq("team_id", teamId).order("tokens_used_30d", { ascending: false });
      if (error) throw toBackendError(error, "telemetry.listLeaderboard");
      return data ?? [];
    },
  };
}
