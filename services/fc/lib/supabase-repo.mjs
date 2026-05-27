import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import { ApiError } from "./http-utils.mjs";

const TEAM_COLUMNS = "id, name, slug, created_at";
const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";

export function createSupabaseBusinessRepository(options) {
  const {
    supabaseUrl,
    publishableKey,
    accessToken,
    createClient = defaultCreateClient,
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  if (!accessToken) throw new Error("accessToken is required");

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  return {
    async listTeams({ limit = 50 } = {}) {
      const { data, error } = await supabase
        .from("teams")
        .select(TEAM_COLUMNS)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(mapTeam);
    },

    async createTeam(input) {
      const args = { p_name: input.name };
      if (input.slug !== undefined) args.p_slug = input.slug;
      const { data, error } = await supabase.rpc("create_team", args);
      if (error) throw error;
      return mapTeam(requiredRow(data, "teams.createTeam"));
    },

    async getTeam(teamId) {
      const { data, error } = await supabase
        .from("teams")
        .select(TEAM_COLUMNS)
        .eq("id", teamId)
        .single();
      if (error) throw error;
      return mapTeam(data);
    },

    async listSessions({ limit = 50, cursor = null } = {}) {
      const { data, error } = await supabase.rpc("list_current_actor_sessions", {
        p_limit: limit,
        p_before_last_message_at: cursor?.lastMessageAt ?? null,
        p_before_created_at: cursor?.createdAt ?? null,
        p_before_id: cursor?.id ?? null,
      });
      if (error) throw error;
      return (data ?? []).map(mapSession);
    },

    async listMessages(sessionId) {
      const query = supabase
        .from("messages")
        .select(MESSAGE_COLUMNS)
        .eq("session_id", sessionId);
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapMessage);
    },

    async insertMessage(sessionId, input) {
      const { data, error } = await supabase
        .from("messages")
        .insert(outgoingMessageRow(sessionId, input))
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) throw error;
      return mapMessage(data);
    },

    async claimInvite(token) {
      const { data, error } = await supabase.rpc("claim_team_invite", { p_token: token });
      if (error) throw error;
      const row = requiredRow(data, "auth.claimInvite");
      return {
        actorId: requiredString(row.actor_id, "auth.claimInvite", "actor_id"),
        teamId: requiredString(row.team_id, "auth.claimInvite", "team_id"),
        actorType: requiredString(row.actor_type, "auth.claimInvite", "actor_type"),
        displayName: requiredString(row.display_name, "auth.claimInvite", "display_name"),
        refreshToken: row.refresh_token ?? null,
      };
    },
  };
}

export function publishableKeyFromEnv(env = process.env) {
  return env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
}

function outgoingMessageRow(sessionId, input) {
  const row = {
    id: input.id,
    team_id: input.teamId,
    session_id: sessionId,
    sender_actor_id: input.senderActorId,
    kind: input.kind ?? "text",
    content: input.content,
    metadata: input.metadata ?? null,
    model: input.model ?? null,
    turn_id: input.turnId ?? null,
    reply_to_message_id: input.replyToMessageId ?? null,
  };
  if (input.createdAt) row.created_at = input.createdAt;
  return row;
}

function mapTeam(row) {
  return {
    id: requiredString(row?.id, "teams.mapTeam", "id"),
    name: requiredString(row?.name, "teams.mapTeam", "name"),
    slug: row?.slug ?? null,
    createdAt: row?.created_at ?? null,
  };
}

function mapSession(row) {
  return {
    id: requiredString(row?.id, "sessions.mapSession", "id"),
    teamId: requiredString(row?.team_id, "sessions.mapSession", "team_id"),
    title: row?.title ?? "",
    mode: row?.mode ?? "solo",
    ideaId: row?.idea_id ?? null,
    lastMessageAt: row?.last_message_at ?? null,
    lastMessagePreview: row?.last_message_preview ?? null,
    hasUnread: row?.has_unread === true,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapMessage(row) {
  return {
    id: requiredString(row?.id, "messages.mapMessage", "id"),
    teamId: requiredString(row?.team_id, "messages.mapMessage", "team_id"),
    sessionId: requiredString(row?.session_id, "messages.mapMessage", "session_id"),
    turnId: row?.turn_id ?? null,
    senderActorId: row?.sender_actor_id ?? null,
    replyToMessageId: row?.reply_to_message_id ?? null,
    kind: row?.kind ?? "text",
    content: row?.content ?? "",
    metadata: row?.metadata ?? null,
    model: row?.model ?? null,
    createdAt: requiredString(row?.created_at, "messages.mapMessage", "created_at"),
    updatedAt: row?.updated_at ?? null,
  };
}

function requiredRow(data, operation) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new ApiError(502, "upstream_unavailable", `${operation} returned no row`);
  return row;
}

function requiredString(value, operation, field) {
  if (typeof value === "string" && value.length > 0) return value;
  throw new ApiError(502, "upstream_unavailable", `${operation} returned invalid ${field}`);
}
