import { randomUUID } from "node:crypto";
import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { ApiError } from "./http-utils.js";

// FC runtime is Node 20 which lacks native WebSocket. supabase-js v2.45+ tries
// to construct a RealtimeClient at createClient() time and throws without a
// transport. We never use Realtime in FC; pass `ws` so the construction
// succeeds. The transport is only opened lazily when realtime channels are
// subscribed, which we never do.
const REALTIME_TRANSPORT_OPTS = { transport: WebSocket };

const DEFAULT_ATTACHMENT_BUCKET = "attachments";
const TEAM_COLUMNS = "id, name, slug, created_at";
const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";
const WORKSPACE_COLUMNS =
  "id, team_id, name, path, agent_id, created_by_member_id, archived, created_at, updated_at";

// Translate the SQLSTATE codes raised by get/set_member_default_agent into the
// same ApiError statuses pg-repo returns, so both backends behave identically.
// 42501 (insufficient privilege) -> 403; 23514 (check violation) -> 409;
// 23503 (foreign-key/not-found) -> 404. Anything else propagates unchanged.
function mapDefaultAgentError(error: any) {
  switch (error?.code) {
    case "42501":
      return new ApiError(403, "forbidden", error.message ?? "forbidden");
    case "23514":
      return new ApiError(409, "invalid_agent", error.message ?? "invalid agent");
    case "23503":
      return new ApiError(404, "not_found", error.message ?? "not found");
    default:
      return error;
  }
}

export function createSupabaseBusinessRepository(options) {
  const {
    supabaseUrl,
    publishableKey,
    accessToken,
    createClient = defaultCreateClient,
    createServiceRoleClient: createServiceRoleClientOpt,
    provisionLiteLlm,
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");
  if (!accessToken) throw new Error("accessToken is required");

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: REALTIME_TRANSPORT_OPTS,
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  async function requireCallerTeamOwner(targetTeamId) {
    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData?.user?.id) {
      throw new ApiError(401, "missing_auth", "authenticated user required");
    }

    const { data: actor, error: actorErr } = await supabase
      .from("actors")
      .select("id")
      .eq("team_id", targetTeamId)
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (actorErr) throw actorErr;
    if (!actor?.id) {
      throw new ApiError(403, "forbidden", "not a member of this team");
    }

    const { data: membership, error: memberErr } = await supabase
      .from("team_members")
      .select("role")
      .eq("team_id", targetTeamId)
      .eq("member_id", actor.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!membership || membership.role !== "owner") {
      throw new ApiError(403, "forbidden", "only team owners may change team share mode");
    }
  }

  async function shareModeServiceRpc(rpcName, args) {
    let admin;
    if (createServiceRoleClientOpt) {
      admin = createServiceRoleClientOpt();
    } else {
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
      if (!serviceKey) {
        throw new Error(
          "SUPABASE_SERVICE_ROLE_KEY is not configured on FC; cannot change team share mode",
        );
      }
      const { createServiceRoleClient } = await import("./supabase.js");
      admin = createServiceRoleClient();
    }
    const { data, error } = await admin.rpc(rpcName, args);
    if (error) {
      const code = error?.code || "";
      if (code === "PGRST202") {
        throw new Error(
          `${rpcName} RPC is missing on the database (apply migration 20260604120000_disable_team_share)`,
        );
      }
      throw error;
    }
    return data;
  }

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
      const args: any = { p_name: input.name };
      if (input.slug !== undefined) args.p_slug = input.slug;
      if (input.displayName !== undefined) args.p_display_name = input.displayName;
      if (input.litellmTeamId !== undefined) args.p_litellm_team_id = input.litellmTeamId;
      if (input.aiGatewayEndpoint !== undefined) args.p_ai_gateway_endpoint = input.aiGatewayEndpoint;
      const { data, error } = await supabase.rpc("create_team", args);
      if (error) throw error;
      const row = requiredRow(data, "teams.createTeam");
      return mapTeam({
        id: row.team_id ?? row.id,
        name: row.team_name ?? row.name,
        slug: row.team_slug ?? row.slug,
        created_at: row.created_at ?? null,
      });
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

    async renameTeam(teamId, { name }) {
      const { data, error } = await supabase.rpc("rename_team", { p_team_id: teamId, p_name: name });
      if (error) throw error;
      return mapTeam(requiredRow(data, "teams.renameTeam"));
    },

    async createTeamInvite(teamId, input) {
      const args: any = {
        p_team_id: teamId,
        p_kind: input.kind,
        p_display_name: input.displayName,
      };
      if (input.teamRole != null) args.p_team_role = input.teamRole;
      if (input.agentKind != null) args.p_agent_kind = input.agentKind;
      if (input.ttlSeconds != null) args.p_ttl_seconds = input.ttlSeconds;
      if (input.targetActorId != null) args.p_target_actor_id = input.targetActorId;
      const { data, error } = await supabase.rpc("create_team_invite", args);
      if (error) throw error;
      const row = requiredRow(data, "teams.createTeamInvite");
      return {
        token: requiredString(row.token, "teams.createTeamInvite", "token"),
        expiresAt: row.expires_at ?? null,
        deeplink: row.deeplink ?? null,
      };
    },

    async removeTeamActor(_teamId, actorId) {
      const { error } = await supabase.rpc("remove_team_actor", { p_actor_id: actorId });
      if (error) throw error;
    },

    async updateCurrentActorProfile(actorId, { displayName, avatarUrl }) {
      const { data, error } = await supabase.rpc("update_current_actor_profile", {
        p_actor_id: actorId,
        p_display_name: displayName,
        p_avatar_url: avatarUrl ?? null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return mapDirectoryActor(row);
    },

    async getMemberDefaultAgent(teamId) {
      const { data, error } = await supabase.rpc("get_member_default_agent", {
        p_team_id: teamId,
      });
      if (error) throw mapDefaultAgentError(error);
      // RPC returns a scalar uuid (or null).
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async setMemberDefaultAgent(teamId, agentId) {
      const { data, error } = await supabase.rpc("set_member_default_agent", {
        p_team_id: teamId,
        p_agent_id: agentId ?? null,
      });
      if (error) throw mapDefaultAgentError(error);
      const value = Array.isArray(data) ? data[0] : data;
      return { defaultAgentId: (value ?? null) as string | null };
    },

    async reportClientVersion(teamId, body) {
      const { error } = await supabase.rpc("report_client_version", {
        p_team_id: teamId,
        p_client_type: body.clientType,
        p_version: body.version,
        p_device_id: body.deviceId,
        p_build: body.build ?? null,
      });
      if (error) throw error;
    },

    // --- Team share mode (Task 3 of share-onboarding refactor) ---

    async enableShareMode(teamId, mode, gitConfig) {
      await requireCallerTeamOwner(teamId);
      const args = {
        p_team_id: teamId,
        p_mode: mode,
        p_git_remote_url: mode === "oss" ? null : (gitConfig?.remoteUrl ?? null),
        p_git_auth_kind: mode === "oss" ? null : (gitConfig?.authKind ?? null),
        p_git_credential_ref: mode === "oss" ? null : (gitConfig?.credentialRef ?? null),
      };
      const data = await shareModeServiceRpc("enable_team_share", args);
      const row = requiredRow(data, "teams.enableShareMode");
      return mapTeam(row);
    },

    async getShareMode(teamId) {
      const { data, error } = await supabase
        .from("teams")
        .select("share_mode, share_enabled_at, git_remote_url, git_auth_kind")
        .eq("id", teamId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return {
          mode: null,
          enabledAt: null,
          gitRemoteUrl: null,
          gitAuthKind: null,
        };
      }
      return {
        mode: data.share_mode ?? null,
        enabledAt: data.share_enabled_at ?? null,
        gitRemoteUrl: data.git_remote_url ?? null,
        gitAuthKind: data.git_auth_kind ?? null,
      };
    },

    async disableShareMode(teamId) {
      await requireCallerTeamOwner(teamId);
      const data = await shareModeServiceRpc("disable_team_share", {
        p_team_id: teamId,
      });
      if (data) requiredRow(data, "teams.disableShareMode");
      return {
        mode: null,
        enabledAt: null,
        gitRemoteUrl: null,
        gitAuthKind: null,
      };
    },

    async setupLiteLlm(teamId) {
      // Lazy import keeps the LiteLLM client out of cold-path repo constructors
      // and makes it trivial to inject in tests via options.provisionLiteLlm.
      const provisioner = provisionLiteLlm ?? (await import("./team-provisioning.js")).provisionTeamLiteLLM;
      // The provisioner uses the team name as an alias; we read the team row
      // (already RLS-scoped to the caller) to pass a stable display name.
      const { data: teamRow, error: teamErr } = await supabase
        .from("teams")
        .select("id, name")
        .eq("id", teamId)
        .single();
      if (teamErr) throw teamErr;
      const provisioning = await provisioner(teamRow?.name ?? teamId);
      if (!provisioning) {
        throw new ApiError(
          503,
          "litellm_unavailable",
          "LiteLLM provisioning is not configured (LITELLM_MASTER_KEY missing)",
        );
      }
      // Persist litellm_team_id + ai_gateway_endpoint via SECURITY DEFINER
      // RPC because team_workspace_config.litellm_team_id is guarded against
      // direct authenticated UPDATEs (see 20260527000004 guard trigger).
      const { error: rpcErr } = await supabase.rpc("update_team_litellm", {
        p_team_id: teamId,
        p_litellm_team_id: provisioning.litellmTeamId,
        p_ai_gateway_endpoint: provisioning.aiGatewayEndpoint,
      });
      if (rpcErr) throw rpcErr;
      return {
        aiGatewayEndpoint: provisioning.aiGatewayEndpoint,
        litellmKey: provisioning.litellmKey,
      };
    },

    async getWorkspaceConfig(teamId) {
      const [teamRes, configRes] = await Promise.all([
        supabase
          .from("teams")
          .select("share_mode, git_remote_url, git_auth_kind")
          .eq("id", teamId)
          .maybeSingle(),
        supabase
          .from("team_workspace_config")
          .select("sync_mode, litellm_team_id")
          .eq("team_id", teamId)
          .maybeSingle(),
      ]);
      if (teamRes.error) throw teamRes.error;
      if (configRes.error) throw configRes.error;
      return {
        shareMode: teamRes.data?.share_mode ?? null,
        gitRemoteUrl: teamRes.data?.git_remote_url ?? null,
        gitAuthKind: teamRes.data?.git_auth_kind ?? null,
        syncMode: configRes.data?.sync_mode ?? null,
        litellmTeamId: configRes.data?.litellm_team_id ?? null,
      };
    },

    async listTeamActors(teamId, { kind = null, limit = 500 } = {}) {
      let query = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("team_id", teamId);
      if (kind) query = query.eq("actor_type", kind);
      query = query.order("last_active_at", { ascending: false, nullsFirst: false })
                   .order("display_name", { ascending: true })
                   .limit(limit);
      const { data, error } = await query;
      if (error) throw error;
      return { items: (data ?? []).map(mapDirectoryActor) };
    },

    async getTeamDirectory(teamId) {
      const [actorsRes, membersRes] = await Promise.all([
        supabase
          .from("actor_directory")
          .select("id, team_id, kind, display_name, avatar_url, metadata")
          .eq("team_id", teamId),
        supabase
          .from("team_members")
          .select("actor_id, team_id, role, joined_at")
          .eq("team_id", teamId),
      ]);
      if (actorsRes.error) throw actorsRes.error;
      if (membersRes.error) throw membersRes.error;
      return {
        actors: (actorsRes.data ?? []).map(mapActor),
        members: (membersRes.data ?? []).map(mapTeamMember),
      };
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

    async patchMessage(messageId, patch) {
      const row: any = {};
      if (patch.content !== undefined) row.content = patch.content;
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
      const { data, error } = await supabase
        .from("messages")
        .update(row)
        .eq("id", messageId)
        .select(MESSAGE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapMessage(data);
    },

    async deleteMessage(messageId) {
      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("id", messageId);
      if (error) throw error;
    },

    async listWorkspaces({ teamId, limit = 50, cursor = null, agentId = null }: any = {}) {
      let query = supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (agentId) {
        query = query.eq("agent_id", agentId);
      }
      if (cursor?.updatedAt) {
        query = query.lt("updated_at", cursor.updatedAt);
      }
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapWorkspace) };
    },

    async upsertWorkspace(input) {
      const row = {
        id: input.id,
        team_id: input.teamId,
        name: input.name,
        path: input.path ?? input.slug ?? null,
        agent_id: input.agentId ?? null,
        created_by_member_id: input.createdByMemberId ?? null,
        archived: input.archived ?? false,
      };
      const { data, error } = await supabase
        .from("workspaces")
        .upsert(row, { onConflict: "id" })
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) throw error;
      return mapWorkspace(data);
    },

    async getWorkspace(workspaceId) {
      const { data, error } = await supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("id", workspaceId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapWorkspace(data);
    },

    async patchWorkspace(workspaceId, patch) {
      const row: any = {};
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.archived !== undefined) row.archived = patch.archived;
      if (patch.slug !== undefined) row.path = patch.slug;
      if (patch.path !== undefined) row.path = patch.path;
      if (patch.agentId !== undefined) row.agent_id = patch.agentId;
      const { data, error } = await supabase
        .from("workspaces")
        .update(row)
        .eq("id", workspaceId)
        .select(WORKSPACE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapWorkspace(data);
    },

    async getTeamWorkspaceConfig(teamId) {
      const { data, error } = await supabase
        .from("team_workspace_config")
        .select("team_id, default_workspace_id, pinned_workspace_ids, updated_at")
        .eq("team_id", teamId)
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        teamId: requiredString(row.team_id, "workspaces.getTeamWorkspaceConfig", "team_id"),
        defaultWorkspaceId: row.default_workspace_id ?? null,
        pinnedWorkspaceIds: row.pinned_workspace_ids ?? [],
        updatedAt: row.updated_at ?? null,
      };
    },

    async putTeamWorkspaceConfig(teamId, input) {
      const row = {
        team_id: teamId,
        default_workspace_id: input.defaultWorkspaceId ?? null,
        pinned_workspace_ids: input.pinnedWorkspaceIds ?? [],
      };
      const { data, error } = await supabase
        .from("team_workspace_config")
        .upsert(row, { onConflict: "team_id" })
        .select("team_id, default_workspace_id, pinned_workspace_ids, updated_at")
        .single();
      if (error) throw error;
      return {
        teamId: requiredString(data.team_id, "workspaces.putTeamWorkspaceConfig", "team_id"),
        defaultWorkspaceId: data.default_workspace_id ?? null,
        pinnedWorkspaceIds: data.pinned_workspace_ids ?? [],
        updatedAt: data.updated_at ?? null,
      };
    },

    async writeForegroundPresence({ deviceId, foregroundUntil }) {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) {
        throw new ApiError(401, "unauthorized", "no authenticated user");
      }
      const { error } = await supabase
        .from("client_presence")
        .upsert(
          { user_id: userId, device_id: deviceId, foreground_until: foregroundUntil },
          { onConflict: "user_id,device_id" }
        );
      if (error) throw error;
    },

    async listShortcutsByScope({ scope, teamId, parentId }: any = {}) {
      let query = supabase.from("shortcuts").select("*").eq("scope", scope);
      if (scope === "team" && teamId) query = query.eq("team_id", teamId);
      // Personal scope is gated by RLS on owner_member_id; no extra filter here.
      if (parentId !== undefined) {
        if (parentId === null) query = query.is("parent_id", null);
        else query = query.eq("parent_id", parentId);
      }
      const { data, error } = await query.order("order", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(mapShortcut);
    },

    async getNotificationPrefs() {
      const { data, error } = await supabase
        .from("notification_prefs")
        .select("user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at")
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      // Frontend expects snake_case raw row shape; returns null when caller
      // has no prefs row yet so it can fall back to DEFAULT_PREFS.
      return row ?? null;
    },

    async registerDevicePushToken(input) {
      // Identity comes from the bearer token, not the client, mirroring
      // writeForegroundPresence. Clients send device/platform/provider/token.
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
      const row = {
        user_id: userId,
        device_id: input.deviceId,
        platform: input.platform ?? "ios",
        provider: input.provider ?? "apns",
        token: input.token,
        app_version: input.appVersion ?? null,
        last_seen_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("device_push_tokens")
        .upsert(row, { onConflict: "user_id,device_id,provider" });
      if (error) throw error;
    },

    async putNotificationPrefs(input) {
      // Identity comes from the bearer token (auth.getUser), not the body —
      // CloudAPI clients no longer hold a Supabase user id.
      const { data: prefUser, error: prefUserErr } = await supabase.auth.getUser();
      if (prefUserErr) throw prefUserErr;
      const prefUserId = input.user_id ?? prefUser?.user?.id;
      if (!prefUserId) throw new ApiError(401, "unauthorized", "no authenticated user");
      // Accept snake_case from the frontend (matches the on-disk row shape).
      const row = {
        user_id: prefUserId,
        enabled: input.enabled ?? true,
        dnd_start_min: input.dnd_start_min ?? null,
        dnd_end_min: input.dnd_end_min ?? null,
        dnd_tz: input.dnd_tz ?? "Asia/Shanghai",
      };
      const { data, error } = await supabase
        .from("notification_prefs")
        .upsert(row, { onConflict: "user_id" })
        .select("user_id, enabled, dnd_start_min, dnd_end_min, dnd_tz, updated_at")
        .single();
      if (error) throw error;
      return data;
    },

    async muteSession(sessionId, input) {
      const row = {
        session_id: sessionId,
        until: input.until ?? null,
      };
      const { error } = await supabase
        .from("session_mutes")
        .upsert(row, { onConflict: "user_id,session_id" });
      if (error) throw error;
    },

    async unmuteSession(sessionId) {
      const { error } = await supabase
        .from("session_mutes")
        .delete()
        .eq("session_id", sessionId);
      if (error) throw error;
    },

    async listMutedSessions() {
      const { data, error } = await supabase
        .from("session_mutes")
        .select("session_id");
      if (error) throw error;
      return { items: (data ?? []).map((r) => r.session_id) };
    },

    async listIdeas({ teamId, archived = false, limit = 50, cursor = null }: any = {}) {
      let query = supabase
        .from("ideas")
        .select("*")
        .eq("team_id", teamId)
        .eq("archived", archived)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (cursor?.updatedAt) {
        query = query.lt("updated_at", cursor.updatedAt);
      }
      const { data, error } = await query;
      if (error) throw error;
      const rows = (data ?? []).slice(0, limit);
      return { items: rows.map(mapIdeaRow) };
    },

    async getIdea(ideaId) {
      const { data, error } = await supabase
        .from("ideas")
        .select("*")
        .eq("id", ideaId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapIdeaRow(data);
    },

    async createIdea(body) {
      const args: any = {
        p_team_id: body.teamId,
        p_title: body.title,
        p_description: body.description ?? body.body ?? "",
      };
      if (body.workspaceId != null) args.p_workspace_id = body.workspaceId;
      const { data, error } = await supabase.rpc("create_idea", args);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const id = requiredString(row?.id, "ideas.createIdea", "id");
      return this.getIdea(id);
    },

    async updateIdea(ideaId, body) {
      const { error } = await supabase.rpc("update_idea", {
        p_idea_id: ideaId,
        p_title: body.title ?? null,
        p_workspace_id: body.workspaceId ?? null,
        p_description: body.description ?? body.body ?? null,
        p_status: body.status ?? null,
      });
      if (error) throw error;
      return this.getIdea(ideaId);
    },

    async archiveIdea(ideaId, { archived = true } = {}) {
      const { error } = await supabase.rpc("archive_idea", { p_idea_id: ideaId, p_archived: archived });
      if (error) throw error;
    },

    async listShortcuts(teamId, { parentId }: any = {}) {
      let query = supabase
        .from("shortcuts")
        .select("*")
        .eq("team_id", teamId)
        .order("order", { ascending: true });
      if (parentId !== undefined) {
        if (parentId === null) {
          query = query.is("parent_id", null);
        } else {
          query = query.eq("parent_id", parentId);
        }
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map(mapShortcutRow);
    },

    async getShortcut(shortcutId) {
      const { data, error } = await supabase
        .from("shortcuts")
        .select("*")
        .eq("id", shortcutId)
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapShortcutRow(data);
    },

    async createShortcut(body) {
      const args = {
        p_scope: body.scope,
        p_label: body.label,
        p_node_type: body.nodeType ?? body.kind,
        p_team_id: body.teamId ?? null,
        p_parent_id: body.parentId ?? null,
        p_icon: body.icon ?? null,
        p_order: body.order ?? body.position ?? 0,
        p_target: body.target ?? "",
      };
      const { data, error } = await supabase.rpc("shortcut_create", args);
      if (error) throw error;
      const id = requiredString(data, "shortcuts.createShortcut", "id");
      return this.getShortcut(id);
    },

    async updateShortcut(shortcutId, patch) {
      const body: any = {};
      if (patch.label !== undefined) body.label = patch.label;
      if (patch.payload !== undefined) body.payload = patch.payload;
      if (patch.parentId !== undefined) body.parent_id = patch.parentId;
      if (patch.position !== undefined) body.position = patch.position;
      const { data, error } = await supabase
        .from("shortcuts")
        .update(body)
        .eq("id", shortcutId)
        .select("*")
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapShortcutRow(data);
    },

    async deleteShortcut(shortcutId) {
      const { error } = await supabase
        .from("shortcuts")
        .delete()
        .eq("id", shortcutId);
      if (error) throw error;
    },

    async batchMoveShortcuts({ moves }) {
      const { error } = await supabase.rpc("shortcut_batch_move", {
        p_moves: moves.map((m) => ({ shortcut_id: m.shortcutId, parent_id: m.parentId, position: m.position })),
      });
      if (error) throw error;
    },

    async setShortcutVisibleRoles(shortcutId, { roleIds }) {
      const { error } = await supabase.rpc("shortcut_set_visible_roles", {
        p_shortcut_id: shortcutId,
        p_role_ids: roleIds,
      });
      if (error) throw error;
    },

    async listTeamRoles(teamId) {
      const { data, error } = await supabase
        .from("team_roles")
        .select("id, team_id, code, name")
        .eq("team_id", teamId);
      if (error) throw error;
      return (data ?? []).map((r) => ({ id: r.id, teamId: r.team_id, code: r.code, name: r.name }));
    },

    async listTeamPermissions(teamId) {
      const { data, error } = await supabase
        .from("permissions")
        .select("resource_id, permission_roles(role_id)")
        .eq("team_id", teamId);
      if (error) throw error;
      return (data ?? []).map((r) => ({ resourceId: r.resource_id, roleIds: (r.permission_roles ?? []).map((x) => x.role_id) }));
    },

    async createIdeaActivity(ideaId, body) {
      const { data, error } = await supabase.rpc("create_idea_activity", {
        p_idea_id: ideaId,
        p_activity_type: body.activityType ?? body.kind,
        p_content: body.content ?? null,
        p_metadata: body.metadata ?? null,
        p_attachment_urls: body.attachmentUrls ?? [],
      });
      if (error) throw error;
      return mapIdeaActivityRow(requiredRow(data, "ideas.createIdeaActivity"));
    },

    async listIdeaActivities(ideaId) {
      const { data, error } = await supabase
        .from("idea_activities")
        .select("id, team_id, idea_id, actor_id, activity_type, content, metadata, attachment_urls, created_at, updated_at")
        .eq("idea_id", ideaId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return { items: (data ?? []).map(mapIdeaActivityRow) };
    },

    async reorderIdeas({ teamId, ideaIds }) {
      const { error } = await supabase.rpc("reorder_ideas", {
        p_team_id: teamId,
        p_idea_ids: ideaIds,
      });
      if (error) throw error;
    },

    async upsertAgentRuntime(body) {
      // team_id is NOT NULL on public.agent_runtimes, but the daemon does not
      // send teamId in its request body. Derive it server-side from the agent
      // actor (actors.team_id) when the caller omits it. This Supabase client
      // is bound to the caller's bearer token, so the read runs under the
      // agent's RLS context (an agent can read its own actor row).
      let teamId = body.teamId;
      if (!teamId) {
        const { data: actorRow, error: actorErr } = await supabase
          .from("actors")
          .select("team_id")
          .eq("id", body.agentActorId)
          .maybeSingle();
        if (actorErr) throw actorErr;
        teamId = actorRow?.team_id ?? null;
      }
      if (!teamId) {
        throw new ApiError(
          400,
          "missing_team",
          "Unable to resolve team_id for agent runtime: agent actor not found or not visible",
        );
      }
      const row = {
        id: body.id ?? randomUUID(),
        team_id: teamId,
        agent_id: body.agentActorId,
        session_id: body.sessionId,
        runtime_id: body.runtimeId,
        backend_type: body.backendType ?? "claude",
        backend_session_id: body.backendSessionId,
        status: body.status ?? "running",
        workspace_id: body.workspaceId ?? null,
        current_model: body.currentModel ?? null,
        updated_at: new Date().toISOString(),
      };
      // The only matching unique index is agent_runtimes_agent_backend_uniq on
      // (agent_id, backend_session_id) (migration 202604220027). onConflict must
      // name a real unique constraint or Postgres raises 42P10.
      const { data, error } = await supabase
        .from("agent_runtimes")
        .upsert(row, { onConflict: "agent_id,backend_session_id" })
        .select("id")
        .single();
      if (error) throw error;
      return { id: data?.id ?? null };
    },

    async getAgentRuntime({ sessionId, runtimeId, backendSessionId }) {
      let query = supabase
        .from("agent_runtimes")
        .select("*")
        .eq("session_id", sessionId);
      if (runtimeId !== undefined && runtimeId !== null) {
        query = query.eq("runtime_id", runtimeId);
      }
      if (backendSessionId !== undefined && backendSessionId !== null) {
        query = query.eq("backend_session_id", backendSessionId);
      }
      const { data, error } = await query.limit(1).single();
      if (error && error.code === "PGRST116") return null;
      if (error) throw error;
      return data ? mapAgentRuntimeRow(data) : null;
    },

    async getLatestAgentRuntime({ agentId, sessionId }) {
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("*")
        .eq("agent_id", agentId)
        .eq("session_id", sessionId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .single();
      if (error && error.code === "PGRST116") return null;
      if (error) throw error;
      return data ? mapAgentRuntimeRow(data) : null;
    },

    async updateRuntimeCursor(runtimeRowId, { lastProcessedMessageId }) {
      const { error } = await supabase
        .from("agent_runtimes")
        .update({ last_processed_message_id: lastProcessedMessageId })
        .eq("id", runtimeRowId);
      if (error) throw error;
    },

    async ensureAgentTypes({ supportedTypes, defaultAgentType }) {
      const { data: actorRow, error: actorErr } = await supabase
        .from("actors")
        .select("id")
        .eq("actor_type", "agent")
        .limit(1)
        .maybeSingle();
      if (actorErr) throw actorErr;
      if (!actorRow?.id) {
        throw new Error("ensureAgentTypes: no agent actor visible to caller");
      }
      const { error } = await supabase
        .from("agents")
        .update({
          agent_types: supportedTypes,
          default_agent_type: defaultAgentType,
        })
        .eq("id", actorRow.id);
      if (error) throw error;
    },

    async uploadAttachment({ path, mime, bytes, bucket }) {
      const targetBucket = bucket || DEFAULT_ATTACHMENT_BUCKET;
      const { error } = await supabase.storage
        .from(targetBucket)
        .upload(path, bytes, { contentType: mime, upsert: true });
      if (error) throw error;
      return {
        path,
        url: `${supabaseUrl}/storage/v1/object/public/${targetBucket}/${path}`,
      };
    },

    async downloadAttachment(path, { bucket }: any = {}) {
      const targetBucket = bucket || DEFAULT_ATTACHMENT_BUCKET;
      const { data, error } = await supabase.storage
        .from(targetBucket)
        .download(path);
      if (error) {
        const status = Number(error?.status || error?.statusCode || 0);
        if (status === 404 || error?.message?.includes("not found") || error?.error === "not_found") return null;
        throw error;
      }
      if (!data) return null;
      const arrayBuffer = await data.arrayBuffer();
      const mime = data.type || "application/octet-stream";
      return { mime, bytes: Buffer.from(arrayBuffer) };
    },

    async submitFeedback(body) {
      const row = {
        message_id: body.messageId,
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        kind: body.kind,
        star_rating: body.starRating ?? null,
        skill: body.skill ?? null,
      };
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .upsert(row, { onConflict: "actor_id,message_id" })
        .select("*")
        .single();
      if (error) throw error;
      return mapFeedbackRow(data);
    },

    async listFeedback({ sessionId }) {
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .select("*")
        .eq("session_id", sessionId);
      if (error) throw error;
      return { items: (data ?? []).map(mapFeedbackRow) };
    },

    async deleteFeedback(messageId, actorId) {
      const query = supabase
        .from("actor_message_feedback")
        .delete()
        .eq("message_id", messageId);
      if (actorId) query.eq("actor_id", actorId);
      const { error } = await query;
      if (error) throw error;
    },

    async getTeamLeaderboard(teamId, { period = "week" } = {}) {
      const { data, error } = await supabase
        .rpc("team_leaderboard", { p_team_id: teamId, p_period: period });
      if (error) throw error;
      const rows = (data ?? []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return { items: rows.map(mapLeaderboardRow) };
    },

    async submitSessionReport(body) {
      // Not transactional: the report row may be written even if the
      // subsequent skill-usage insert fails. Acceptable for best-effort
      // telemetry — a throw here means the caller sees failure, but the
      // report row can still exist. supabase-js has no multi-table txn.
      const reportRow = {
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        tokens_used: body.tokensUsed ?? 0,
        cost_usd: body.costUsd ?? 0,
        model: body.model ?? null,
        agent_kind: body.agentKind ?? null,
        ended_at: body.endedAt ?? null,
      };
      const { error: reportErr } = await supabase
        .from("actor_session_report")
        .insert(reportRow);
      if (reportErr) throw reportErr;

      const skillRows = Object.entries(body.skillUsage ?? {})
        .filter(([, count]) => Number(count) > 0)
        .map(([skill, count]) => ({
          actor_id: body.actorId,
          team_id: body.teamId,
          session_id: body.sessionId ?? null,
          skill,
          count: Number(count),
        }));
      if (skillRows.length > 0) {
        const { error: skillErr } = await supabase
          .from("actor_skill_usage")
          .insert(skillRows);
        if (skillErr) throw skillErr;
      }
    },

    async submitSkillUsage(body) {
      const row = {
        actor_id: body.actorId,
        team_id: body.teamId,
        session_id: body.sessionId ?? null,
        skill: body.skill,
        count: Number(body.count ?? 1),
      };
      const { error } = await supabase.from("actor_skill_usage").insert(row);
      if (error) throw error;
    },

    async listFeedbackSummary(teamId) {
      // TODO: replace with a DB-side GROUP BY aggregate (or a view/rpc) when
      // per-team feedback row counts grow — this fetches all rows and reduces
      // in JS. displayName is left null here; callers resolve it separately
      // (the leaderboard rpc already returns display_name).
      const { data, error } = await supabase
        .from("actor_message_feedback")
        .select("actor_id, kind")
        .eq("team_id", teamId);
      if (error) throw error;
      const byActor = new Map();
      for (const r of data ?? []) {
        const e = byActor.get(r.actor_id) ?? { actorId: r.actor_id, displayName: null, positive: 0, negative: 0, total: 0 };
        if (r.kind === "positive") e.positive += 1;
        if (r.kind === "negative") e.negative += 1;
        e.total += 1;
        byActor.set(r.actor_id, e);
      }
      return { items: [...byActor.values()] };
    },

    // --- Directory resolution (frontend supabase delegate parity) ---

    async resolveCallerActorForTeam(teamId) {
      // Resolve the bearer caller's member actor in this team (not any member).
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) return null;
      return this.resolveCurrentMemberActor(teamId, userId);
    },

    async resolveCurrentMemberActor(teamId, userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id } : null;
    },

    async resolveFirstMemberActorForUser(userId) {
      const { data, error } = await supabase
        .from("actors")
        .select("id, team_id")
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, team_id: data.team_id ?? null } : null;
    },

    async getCurrentTeamMember(teamId, userId) {
      const { data: actorRows, error: actorError } = await supabase
        .from("actor_directory")
        .select("id, display_name, team_role")
        .eq("team_id", teamId)
        .eq("user_id", userId)
        .eq("actor_type", "member")
        .limit(1);
      if (actorError) throw actorError;
      const actor = actorRows?.[0];
      if (!actor) return null;
      const { data: memberRows, error: memberError } = await supabase
        .from("team_members")
        .select("joined_at")
        .eq("team_id", teamId)
        .eq("member_id", actor.id)
        .limit(1);
      return {
        id: actor.id,
        displayName: actor.display_name || "",
        role: actor.team_role ?? null,
        joinedAt: memberError ? null : memberRows?.[0]?.joined_at ?? null,
      };
    },

    // --- Sync (incremental) ---

    async listActorDirectoryForSync(teamId, updatedAfter) {
      let q = supabase
        .from("actor_directory")
        .select(
          "id, team_id, actor_type, display_name, member_status, agent_status, last_active_at, created_at, updated_at",
        )
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listIdeasForSync(teamId, updatedAfter) {
      let q = supabase
        .from("ideas")
        .select(
          "id, team_id, workspace_id, parent_idea_id, title, description, status, created_by_actor_id, archived, sort_order, created_at, updated_at",
        )
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listSessionParticipantsForSync(sessionId, updatedAfter) {
      let q = supabase
        .from("session_participants")
        .select("id, session_id, actor_id, joined_at, created_at, updated_at")
        .eq("session_id", sessionId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    // --- Actor directory by ids + remove agent access ---

    async listActorDirectoryByIds(actorIds, teamId) {
      if (!Array.isArray(actorIds) || actorIds.length === 0) return [];
      let q = supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .in("id", actorIds);
      if (teamId) q = q.eq("team_id", teamId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map(mapDirectoryActor);
    },

    async removeAgentAccessById(accessId) {
      const { error } = await supabase
        .from("agent_member_access")
        .delete()
        .eq("id", accessId);
      if (error) throw error;
    },

    // --- Team workspace git config (separate column set from
    // existing default/pinned workspace config) ---

    async getMeBootstrap() {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const userId = userData?.user?.id;
      if (!userId) {
        throw new ApiError(401, "unauthorized", "no authenticated user");
      }
      const { data: actorRows, error: actorErr } = await supabase
        .from("actors")
        .select("id")
        .eq("user_id", userId)
        .eq("actor_type", "member");
      if (actorErr) throw actorErr;
      const actorIds = (actorRows ?? []).map((r) => r.id);
      if (actorIds.length === 0) {
        return { memberActorId: null, teams: [], memberActorIdByTeam: {} };
      }
      const { data: memberRows, error: memberErr } = await supabase
        .from("team_members")
        .select("role, member_id, teams!inner(id, name, slug)")
        .in("member_id", actorIds);
      if (memberErr) throw memberErr;
      const seenTeam = new Map();
      const memberByTeam = {};
      for (const m of memberRows ?? []) {
        const t = m.teams;
        if (!t?.id) continue;
        if (!seenTeam.has(t.id)) {
          seenTeam.set(t.id, { id: t.id, name: t.name, slug: t.slug, role: m.role });
        }
        memberByTeam[t.id] = m.member_id;
      }
      const teams = Array.from(seenTeam.values());
      const primary = teams[0] ? memberByTeam[teams[0].id] : null;
      return {
        memberActorId: primary ?? null,
        teams,
        memberActorIdByTeam: memberByTeam,
      };
    },

    async listTeamSessionsFull(teamId) {
      const FULL_COLUMNS =
        "id, team_id, title, mode, primary_agent_id, idea_id, summary, last_message_preview, last_message_at, created_by_actor_id, created_at, updated_at";
      const { data: sessionRows, error: sessionErr } = await supabase
        .from("sessions")
        .select(FULL_COLUMNS)
        .eq("team_id", teamId)
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (sessionErr) throw sessionErr;
      const rows = sessionRows ?? [];
      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const { data: pRows, error: pErr } = await supabase
        .from("session_participants")
        .select("session_id")
        .in("session_id", ids);
      if (pErr) throw pErr;
      const counts = (pRows ?? []).reduce((acc, r) => {
        acc[r.session_id] = (acc[r.session_id] ?? 0) + 1;
        return acc;
      }, {});

      return rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        title: row.title ?? "",
        mode: row.mode ?? "solo",
        ideaId: row.idea_id ?? null,
        primaryAgentId: row.primary_agent_id ?? null,
        createdByActorId: row.created_by_actor_id ?? null,
        summary: row.summary ?? null,
        lastMessageAt: row.last_message_at ?? null,
        lastMessagePreview: row.last_message_preview ?? null,
        participantCount: counts[row.id] ?? 0,
        hasUnread: false,
        createdAt: row.created_at ?? null,
        updatedAt: row.updated_at ?? null,
      }));
    },

    async listAgentRuntimesForTeam(teamId) {
      const COLS =
        "id, team_id, agent_id, session_id, workspace_id, backend_type, status, backend_session_id, runtime_id, current_model, last_seen_at, created_at, updated_at";
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select(COLS)
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        teamId: row.team_id,
        agentId: row.agent_id,
        sessionId: row.session_id ?? null,
        workspaceId: row.workspace_id ?? null,
        backendType: row.backend_type,
        status: row.status,
        backendSessionId: row.backend_session_id ?? null,
        runtimeId: row.runtime_id ?? null,
        currentModel: row.current_model ?? null,
        lastSeenAt: row.last_seen_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    async listSessionsForTeamSince(teamId, updatedAfter) {
      const SESSION_SYNC_COLUMNS =
        "id, team_id, title, mode, primary_agent_id, idea_id, summary, last_message_preview, last_message_at, created_by_actor_id, created_at, updated_at";
      let q = supabase
        .from("sessions")
        .select(SESSION_SYNC_COLUMNS)
        .eq("team_id", teamId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listMessagesForSessionSince(sessionId, updatedAfter) {
      const MESSAGE_SYNC_COLUMNS =
        "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";
      let q = supabase
        .from("messages")
        .select(MESSAGE_SYNC_COLUMNS)
        .eq("session_id", sessionId);
      if (updatedAfter) q = q.gt("updated_at", updatedAfter);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },

    async listSessionDisplayRows(teamId, sessionIds) {
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
      const { data, error } = await supabase
        .from("sessions")
        .select("id, title")
        .eq("team_id", teamId)
        .in("id", sessionIds);
      if (error) throw error;
      return data ?? [];
    },

    async listSessionIdsForActor(actorId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id")
        .eq("actor_id", actorId);
      if (error) throw error;
      return (data ?? []).map((r) => r.session_id).filter(Boolean);
    },

    async listWorkspacesByIdsSlim(teamId, workspaceIds) {
      if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) return [];
      const { data, error } = await supabase
        .from("workspaces")
        .select("id, name, path")
        .eq("team_id", teamId)
        .in("id", workspaceIds);
      if (error) throw error;
      return data ?? [];
    },

    async listShortcutRoleBindings(teamId) {
      const { data, error } = await supabase
        .from("permissions")
        .select("resource_id, permission_roles(role_id)")
        .eq("team_id", teamId)
        .eq("resource_type", "shortcut");
      if (error) throw error;
      return data ?? [];
    },

    async loadTeamWorkspaceGitConfig(teamId) {
      const { data, error } = await supabase
        .from("team_workspace_config")
        .select("team_id, git_url, git_branch, git_token, ai_gateway_endpoint, enabled, updated_at")
        .eq("team_id", teamId)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },

    async saveTeamWorkspaceGitConfig(input) {
      const { error } = await supabase
        .from("team_workspace_config")
        .upsert(input, { onConflict: "team_id" });
      if (error) throw error;
    },

    // --- Sessions CRUD (single-session ops; list uses listSessions above) ---

    async getSession(sessionId) {
      const { data, error } = await supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("id", sessionId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapSessionFull(data) : null;
    },

    async createSession(input) {
      // The frontend createSessionShell path supplies a client-generated id
      // plus an additionalActorIds list. Insert the session row directly and
      // bootstrap participants. The `create_session` RPC isn't used because
      // it requires `idea_id` (NOT NULL via legacy schema gated behind
      // newer migrations) and assumes the caller as the only seat.
      const id = input.id ?? randomUUID();
      let createdByActorId = input.createdByActorId;
      if (!createdByActorId) {
        const { data: userData, error: userErr } = await supabase.auth.getUser();
        if (userErr) throw userErr;
        const userId = userData?.user?.id;
        if (!userId) throw new ApiError(401, "unauthorized", "no authenticated user");
        const resolved = await this.resolveCurrentMemberActor(input.teamId, userId);
        if (!resolved?.id) throw new ApiError(403, "forbidden", "not a member of this team");
        createdByActorId = resolved.id;
      }
      const insertRow: any = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        idea_id: input.ideaId ?? null,
        created_by_actor_id: createdByActorId,
      };
      if (input.primaryAgentId) insertRow.primary_agent_id = input.primaryAgentId;
      const { data, error } = await supabase
        .from("sessions")
        .insert(insertRow)
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (error) throw error;

      const additionalIds = Array.isArray(input.additionalActorIds) ? input.additionalActorIds : [];
      const participantIds = Array.isArray(input.participantActorIds) ? input.participantActorIds : [];
      const seedActorIds = Array.from(
        new Set(
          [
            createdByActorId,
            ...additionalIds,
            ...participantIds,
          ].filter((x) => typeof x === "string" && x.length > 0),
        ),
      );
      if (seedActorIds.length > 0) {
        const rows = seedActorIds.map((actorId) => ({ session_id: id, actor_id: actorId }));
        const { error: partError } = await supabase
          .from("session_participants")
          .upsert(rows, { onConflict: "session_id,actor_id" });
        if (partError) throw partError;
      }
      return mapSessionFull(data);
    },

    async patchSession(sessionId, patch) {
      const update: any = {};
      if (patch.title !== undefined) update.title = patch.title;
      if (patch.summary !== undefined) update.summary = patch.summary;
      if (patch.archivedAt !== undefined) update.archived_at = patch.archivedAt;
      if (patch.mode !== undefined) update.mode = patch.mode;
      if (Object.keys(update).length === 0) {
        return this.getSession(sessionId);
      }
      const { data, error } = await supabase
        .from("sessions")
        .update(update)
        .eq("id", sessionId)
        .select(SESSION_FULL_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data ? mapSessionFull(data) : null;
    },

    async markSessionViewed(sessionId, lastReadMessageId = null) {
      const { error } = await supabase.rpc("mark_current_actor_session_viewed", {
        p_session_id: sessionId,
        p_last_read_message_id: lastReadMessageId ?? null,
      });
      if (error) throw error;
    },

    async markSessionUnread(sessionId) {
      // Delete the caller's read marker so the session re-derives as unread.
      // RLS scopes the delete to the current actor via the "write own markers"
      // FOR ALL policy, so no explicit actor filter is needed here.
      const { error } = await supabase
        .from("session_read_markers")
        .delete()
        .eq("session_id", sessionId);
      if (error) throw error;
    },

    async getSessionByAcp(acpSessionId) {
      const { data, error } = await supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("acp_session_id", acpSessionId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // The amuxd daemon (get_gateway_session_by_acp_id) deserializes this into
      // { sessionId: required String, gatewaySessionId: Option<String> } and
      // uses gatewaySessionId as the chat binding for the per-session MCP
      // config. mapSessionFull alone exposes `id`/`binding` (not the camelCase
      // names the daemon expects), so surface both explicitly.
      return {
        ...mapSessionFull(data),
        sessionId: data.id,
        gatewaySessionId: data.binding ?? null,
      };
    },

    async ensureGatewaySession(input) {
      const { data, error } = await supabase.rpc("ensure_gateway_session", {
        p_team_id: input.teamId,
        p_binding: input.binding,
        p_title: input.title,
        p_primary_agent_actor_id: input.primaryAgentActorId,
        p_owner_member_actor_ids: input.ownerMemberActorIds ?? [],
        p_participant_actor_ids: input.participantActorIds ?? [],
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new ApiError(502, "upstream_unavailable", "ensure_gateway_session returned no row");
      const acpSessionId = row.acp_session_id ?? row.acpSessionId ?? null;
      return {
        sessionId: row.session_id ?? row.sessionId ?? null,
        // The amuxd daemon deserializes `gatewaySessionId` as a REQUIRED field
        // and uses it as the logical ACP session id it later looks up via
        // getSessionByAcp (which queries the acp_session_id column) — so it must
        // equal acp_session_id to round-trip. Omitting it made WeCom inbound
        // messages fail with "missing field gatewaySessionId". The pg-repo
        // backend already returns this field; this keeps the two in lockstep.
        gatewaySessionId: acpSessionId,
        acpSessionId,
        created: row.created === true,
      };
    },

    async createCronSession(input) {
      // Cron sessions are plain `mode='collab'` sessions with no idea_id and
      // a marker in `summary` or metadata. The supabase create_session RPC
      // requires an idea_id, so we insert directly to bypass that constraint.
      const id = input.id ?? randomUUID();
      const insertRow: any = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: "collab",
        primary_agent_id: input.primaryAgentActorId,
      };
      if (input.createdByActorId) insertRow.created_by_actor_id = input.createdByActorId;
      else insertRow.created_by_actor_id = input.primaryAgentActorId;
      const { data, error } = await supabase
        .from("sessions")
        .insert(insertRow)
        .select(SESSION_FULL_COLUMNS)
        .single();
      if (error) throw error;
      // Bootstrap primary agent as participant.
      const { error: partError } = await supabase
        .from("session_participants")
        .upsert(
          [{ session_id: id, actor_id: input.primaryAgentActorId }],
          { onConflict: "session_id,actor_id" },
        );
      if (partError) throw partError;

      // Mirror gateway sessions: add human admins of the primary agent so
      // desktop users can open cron run history via "查看对话". Without this,
      // sessions_select_if_participant_or_creator hides the row from members
      // who are not the agent actor (see 202605060001_sessions_select_only_participants).
      const { data: adminRows, error: adminErr } = await supabase.rpc(
        "list_agent_admin_member_actor_ids",
        { p_agent_actor_id: input.primaryAgentActorId },
      );
      if (adminErr) throw adminErr;
      const adminActorIds = (adminRows ?? [])
        .map((row) => (typeof row === "string" ? row : row?.member_actor_id))
        .filter((id) => typeof id === "string" && id.length > 0);
      if (adminActorIds.length > 0) {
        const { error: adminPartErr } = await supabase
          .from("session_participants")
          .upsert(
            adminActorIds.map((actor_id) => ({ session_id: id, actor_id })),
            { onConflict: "session_id,actor_id" },
          );
        if (adminPartErr) throw adminPartErr;
      }

      return { sessionId: data.id, ...mapSessionFull(data) };
    },

    // --- Session members (participants) ---

    async listSessionParticipants(sessionId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id, actor_id, role, joined_at")
        .eq("session_id", sessionId);
      if (error) throw error;
      const rows = data ?? [];
      const actorIds = rows.map((r) => r.actor_id).filter(Boolean);
      let actorsById = new Map();
      if (actorIds.length > 0) {
        const { data: actors, error: actorsErr } = await supabase
          .from("actor_directory")
          .select("id, team_id, actor_type, display_name, avatar_url")
          .in("id", actorIds);
        if (actorsErr) throw actorsErr;
        actorsById = new Map((actors ?? []).map((a) => [a.id, a]));
      }
      const items = rows.map((row) => {
        const actor = actorsById.get(row.actor_id);
        return {
          sessionId: row.session_id,
          actorId: row.actor_id,
          role: row.role ?? null,
          joinedAt: row.joined_at ?? null,
          teamId: actor?.team_id ?? null,
          actorType: actor?.actor_type ?? null,
          displayName: actor?.display_name ?? null,
          avatarUrl: actor?.avatar_url ?? null,
        };
      });
      return { items };
    },

    async upsertSessionParticipant(sessionId, input) {
      const row: any = {
        session_id: sessionId,
        actor_id: input.actorId,
      };
      if (input.role !== undefined) row.role = input.role;
      const { data, error } = await supabase
        .from("session_participants")
        .upsert(row, { onConflict: "session_id,actor_id" })
        .select("session_id, actor_id, role, joined_at")
        .single();
      if (error) throw error;
      return {
        sessionId: data.session_id,
        actorId: data.actor_id,
        role: data.role ?? null,
        joinedAt: data.joined_at ?? null,
      };
    },

    async removeSessionParticipant(sessionId, actorId) {
      const { error } = await supabase
        .from("session_participants")
        .delete()
        .eq("session_id", sessionId)
        .eq("actor_id", actorId);
      if (error) throw error;
    },

    // --- Actor reads + external + access (member-access table) ---

    async getActor(actorId) {
      const { data, error } = await supabase
        .from("actor_directory")
        .select(ACTOR_DIRECTORY_COLUMNS)
        .eq("id", actorId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const actor = mapDirectoryActor(data);
      const { data: versions, error: vErr } = await supabase
        .from("actor_client_versions")
        .select("client_type, version, device_id, build, last_reported_at")
        .eq("actor_id", actorId)
        .order("client_type", { ascending: true })
        .order("last_reported_at", { ascending: false });
      if (vErr) throw vErr;
      return {
        ...actor,
        clientVersions: (versions ?? []).map((v) => ({
          clientType: v.client_type,
          version: v.version,
          deviceId: v.device_id,
          build: v.build ?? null,
          lastReportedAt: v.last_reported_at,
        })),
      };
    },

    async upsertExternalActor(input) {
      const { data, error } = await supabase.rpc("upsert_external_actor", {
        p_team_id: input.teamId,
        p_source: input.source,
        p_source_id: input.sourceId,
        p_display_name: input.displayName,
      });
      if (error) throw error;
      // RPC returns the actor uuid scalar.
      const actorId = typeof data === "string" ? data : (Array.isArray(data) ? data[0] : null);
      if (!actorId) throw new ApiError(502, "upstream_unavailable", "upsert_external_actor returned no id");
      return { actorId };
    },

    async checkAgentPermission(agentActorId, actorId) {
      const { data, error } = await supabase.rpc("check_agent_permission", {
        p_agent_id: agentActorId,
        p_actor_id: actorId,
      });
      if (error) throw error;
      // RPC returns a text scalar (permission_level) or null.
      const role = typeof data === "string" && data.length > 0 ? data : null;
      return { allowed: role !== null, role };
    },

    async grantAgentAccess(agentActorId, { actorId, role }) {
      const { data, error } = await supabase
        .from("agent_member_access")
        .upsert(
          {
            agent_id: agentActorId,
            member_id: actorId,
            permission_level: role,
          },
          { onConflict: "agent_id,member_id" },
        )
        .select("id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at")
        .single();
      if (error) throw error;
      return {
        id: data.id,
        agentActorId: data.agent_id,
        actorId: data.member_id,
        role: data.permission_level,
        grantedByMemberId: data.granted_by_member_id ?? null,
        createdAt: data.created_at ?? null,
        updatedAt: data.updated_at ?? null,
      };
    },

    async revokeAgentAccess(agentActorId, actorId) {
      const { error } = await supabase
        .from("agent_member_access")
        .delete()
        .eq("agent_id", agentActorId)
        .eq("member_id", actorId);
      if (error) throw error;
    },

    async listAgentAdminMembers(agentActorId) {
      const { data, error } = await supabase.rpc("list_agent_admin_member_actor_ids", {
        p_agent_actor_id: agentActorId,
      });
      if (error) throw error;
      const items = (data ?? [])
        .map((row) => (typeof row === "string" ? row : row?.member_actor_id))
        .filter((id) => typeof id === "string" && id.length > 0);
      return { items };
    },

    // --- Runtime liveness ---

    async heartbeat() {
      // Probe + update last_active_at so clients see the daemon as online.
      const { error } = await supabase.rpc("update_actor_last_active");
      if (error) throw error;
    },

    // --- Actor agent management (RPCs) ---

    async listConnectedAgents(teamId) {
      const { data, error } = await supabase.rpc("list_connected_agents", { p_team_id: teamId });
      if (error) throw error;
      const items = (data ?? []).map((row) => {
        const id = row.id ?? row.agent_id;
        return {
          id,
          teamId: row.team_id ?? teamId,
          kind: row.actor_type ?? "agent",
          displayName: row.display_name ?? null,
          avatarUrl: row.avatar_url ?? null,
          userId: row.user_id ?? null,
          teamRole: row.team_role ?? null,
          memberStatus: row.member_status ?? null,
          agentStatus: row.agent_status ?? null,
          agentTypes: row.agent_types ?? null,
          defaultAgentType: row.default_agent_type ?? null,
          defaultWorkspaceId: row.default_workspace_id ?? null,
          lastActiveAt: row.last_active_at ?? null,
          createdAt: row.created_at ?? null,
          updatedAt: row.updated_at ?? null,
          agentId: row.agent_id ?? id,
          // Fields the list_connected_agents RPC computes that clients need
          // (iOS ConnectedAgent: permission level, visibility, ownership).
          permissionLevel: row.permission_level ?? null,
          visibility: row.visibility ?? null,
          isOwner: row.is_owner === true,
        };
      }).filter((row) => typeof row.id === "string" && row.id.length > 0);
      return { items };
    },

    async shareAgentToTeam(agentActorId) {
      const { error } = await supabase.rpc("share_agent_to_team", { p_agent_id: agentActorId });
      if (error) throw error;
    },

    async makeAgentPersonal(agentActorId) {
      const { error } = await supabase.rpc("make_agent_personal", { p_agent_id: agentActorId });
      if (error) throw error;
    },

    async updateOwnedAgentProfile(agentActorId, patch) {
      const { error } = await supabase.rpc("update_owned_agent_profile", {
        p_agent_id: agentActorId,
        p_display_name: patch.displayName ?? null,
        p_visibility: patch.visibility ?? null,
      });
      if (error) throw error;
    },

    async updateAgentDefaults(agentActorId, patch) {
      const { error } = await supabase.rpc("update_agent_defaults", {
        p_agent_id: agentActorId,
        p_default_workspace_id: patch.defaultWorkspaceId ?? null,
        p_agent_kind: patch.agentKind ?? null,
        p_default_agent_type: patch.defaultAgentType ?? null,
      });
      if (error) throw error;
    },

    async listAgentAccess(agentActorId) {
      const { data, error } = await supabase
        .from("agent_member_access")
        .select("id, agent_id, member_id, permission_level, granted_by_member_id, created_at, updated_at")
        .eq("agent_id", agentActorId)
        .order("permission_level", { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      const memberIds = [...new Set(rows.map((row) => row.member_id))];
      const memberInfo = new Map();
      if (memberIds.length > 0) {
        const { data: members, error: memberError } = await supabase
          .from("actor_directory")
          .select("id, display_name, actor_type, last_active_at")
          .in("id", memberIds);
        if (memberError) throw memberError;
        for (const member of members ?? []) {
          memberInfo.set(member.id, member);
        }
      }
      const items = rows.map((row) => {
        const member = memberInfo.get(row.member_id);
        return {
          id: row.id,
          agentId: row.agent_id,
          agentActorId: row.agent_id,
          actorId: row.member_id,
          memberId: row.member_id,
          memberName: member?.display_name || row.member_id,
          actorType: member?.actor_type ?? null,
          lastActiveAt: member?.last_active_at ?? null,
          role: row.permission_level,
          permissionLevel: row.permission_level,
          grantedByMemberId: row.granted_by_member_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
      return { items };
    },

    async listLatestAgentRuntimeHints(teamId, agentIds) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("id, agent_id, workspace_id, backend_type, runtime_id, session_id, status, current_model, updated_at")
        .eq("team_id", teamId)
        .in("agent_id", agentIds)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      const latest = new Map();
      for (const row of data ?? []) {
        if (!latest.has(row.agent_id)) latest.set(row.agent_id, row);
      }
      return [...latest.values()].map((row) => ({
        id: row.id,
        agent_id: row.agent_id,
        workspace_id: row.workspace_id ?? null,
        backend_type: row.backend_type ?? null,
        runtime_id: row.runtime_id ?? null,
        session_id: row.session_id ?? null,
        status: row.status ?? null,
        current_model: row.current_model ?? null,
        updated_at: row.updated_at ?? null,
      }));
    },

    async listAgentDefaults(agentIds) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const { data, error } = await supabase
        .from("agents")
        .select("id, agent_types, default_agent_type, default_workspace_id")
        .in("id", agentIds);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        agentTypes: Array.isArray(row.agent_types) ? row.agent_types : null,
        defaultAgentType: row.default_agent_type ?? null,
        // The amuxd daemon reads this to resolve the gateway runtime's working
        // directory from its own agent's default workspace.
        defaultWorkspaceId: row.default_workspace_id ?? null,
      }));
    },

    async updateRuntimeModel(runtimeId, model) {
      const { error } = await supabase
        .from("agent_runtimes")
        .update({ current_model: model })
        .eq("runtime_id", runtimeId);
      if (error) throw error;
    },

    async listSessionRuntimeModels(sessionId) {
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("id, runtime_id, agent_id, workspace_id, backend_type, current_model, status")
        .eq("session_id", sessionId);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id ?? null,
        runtime_id: row.runtime_id ?? null,
        agent_id: row.agent_id ?? null,
        workspace_id: row.workspace_id ?? null,
        backend_type: row.backend_type ?? null,
        current_model: row.current_model ?? null,
        status: row.status ?? null,
      }));
    },

    async listRuntimeTargetsForSession(sessionId, agentIds) {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return [];
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("agent_id, runtime_id")
        .eq("session_id", sessionId)
        .in("agent_id", agentIds);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        agent_id: row.agent_id ?? null,
        runtime_id: row.runtime_id ?? null,
      }));
    },

    async listDaemonRuntimes(teamId) {
      const { data, error } = await supabase
        .from("agent_runtimes")
        .select("id, runtime_id, team_id, agent_id, session_id, workspace_id, backend_type, backend_session_id, status, current_model, last_seen_at, created_at, updated_at")
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        runtimeId: row.runtime_id ?? null,
        teamId: row.team_id,
        agentId: row.agent_id,
        sessionId: row.session_id ?? null,
        workspaceId: row.workspace_id ?? null,
        backendType: row.backend_type,
        backendSessionId: row.backend_session_id ?? null,
        status: row.status,
        currentModel: row.current_model ?? null,
        lastSeenAt: row.last_seen_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
  };
}

const SESSION_FULL_COLUMNS =
  "id, team_id, title, mode, idea_id, primary_agent_id, created_by_actor_id, summary, last_message_preview, last_message_at, acp_session_id, binding, created_at, updated_at";

const ACTOR_DIRECTORY_COLUMNS =
  "id, team_id, actor_type, user_id, invited_by_actor_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, agent_visibility, last_active_at, created_at, updated_at";

function mapSessionFull(row) {
  return {
    id: row?.id,
    teamId: row?.team_id ?? null,
    title: row?.title ?? "",
    mode: row?.mode ?? "solo",
    ideaId: row?.idea_id ?? null,
    primaryAgentId: row?.primary_agent_id ?? null,
    createdByActorId: row?.created_by_actor_id ?? null,
    summary: row?.summary ?? null,
    lastMessageAt: row?.last_message_at ?? null,
    lastMessagePreview: row?.last_message_preview ?? null,
    hasUnread: false,
    acpSessionId: row?.acp_session_id ?? null,
    binding: row?.binding ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapDirectoryActor(row) {
  return {
    id: row?.id,
    teamId: row?.team_id ?? null,
    kind: row?.actor_type ?? null,
    displayName: row?.display_name ?? null,
    avatarUrl: row?.avatar_url ?? null,
    userId: row?.user_id ?? null,
    invitedByActorId: row?.invited_by_actor_id ?? null,
    teamRole: row?.team_role ?? null,
    memberStatus: row?.member_status ?? null,
    agentStatus: row?.agent_status ?? null,
    agentTypes: row?.agent_types ?? null,
    agentKind: null,
    defaultAgentType: row?.default_agent_type ?? null,
    defaultWorkspaceId: row?.default_workspace_id ?? null,
    visibility: row?.agent_visibility ?? null,
    lastActiveAt: row?.last_active_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function publishableKeyFromEnv(env = process.env) {
  return env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
}

export function createSupabaseAuthRepository(options) {
  const {
    supabaseUrl,
    publishableKey,
    fetchImpl = globalThis.fetch,
    createClient = defaultCreateClient,
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");

  // Anonymous Supabase client (no Authorization header). Used for the
  // `claim_team_invite` SECURITY DEFINER RPC which the daemon must call
  // before it owns any auth token.
  const anonClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: REALTIME_TRANSPORT_OPTS,
  });

  // Build a Supabase client authorized as the caller, so the SECURITY DEFINER
  // RPC sees `auth.uid()` (required for `kind='member'` claims). Lazily created
  // per access token; the daemon's agent-claim flow has no token and reuses the
  // shared anonClient.
  function clientForToken(accessToken) {
    if (!accessToken) return anonClient;
    return createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: REALTIME_TRANSPORT_OPTS,
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  }

  return {
    // ctx.accessToken (optional): the joining user's bearer. Forwarded so the
    // `claim_team_invite` RPC resolves `auth.uid()` for member invites. Absent
    // for agent invites (daemon `amuxd init`), which the RPC self-provisions.
    async claimInvite(token, ctx: { accessToken?: string } = {}) {
      const client = clientForToken(ctx.accessToken);
      const { data, error } = await client.rpc("claim_team_invite", { p_token: token });
      if (error) {
        const msg = error.message || "claim_team_invite failed";
        const lower = msg.toLowerCase();
        if (lower.includes("not found") || lower.includes("invite invalid") || lower.includes("invalid invite")) {
          throw new ApiError(404, "not_found", `invite invalid or expired: ${msg}`);
        }
        if (lower.includes("already claimed") || lower.includes("claimed")) {
          throw new ApiError(409, "conflict", `invite already claimed: ${msg}`);
        }
        throw new ApiError(400, "validation_failed", msg);
      }
      const row = requiredRow(data, "auth.claimInvite");
      return {
        actorId: requiredString(row.actor_id, "auth.claimInvite", "actor_id"),
        teamId: requiredString(row.team_id, "auth.claimInvite", "team_id"),
        actorType: requiredString(row.actor_type, "auth.claimInvite", "actor_type"),
        displayName: requiredString(row.display_name, "auth.claimInvite", "display_name"),
        refreshToken: row.refresh_token ?? null,
      };
    },

    async refreshAccessToken({ refreshToken }) {
      const url = `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: publishableKey,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new ApiError(401, "missing_auth", `Token refresh failed: ${text}`);
      }

      const body = await res.json();
      return {
        accessToken: requiredString(body.access_token, "auth.refreshAccessToken", "access_token"),
        refreshToken: requiredString(body.refresh_token, "auth.refreshAccessToken", "refresh_token"),
        expiresAt: requiredInteger(body.expires_at, "auth.refreshAccessToken", "expires_at"),
      };
    },

    async signInAnonymous() {
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/signup",
        body: { data: {} },
        operation: "auth.signInAnonymous",
      });
    },

    async signInOtp({ email, phone, options }) {
      // GoTrue /otp accepts either `email` or `phone` (E.164). For phone the
      // `channel` option ("sms" | "whatsapp") selects delivery; default sms.
      const body: Record<string, any> = {};
      if (typeof email === "string" && email.length > 0) body.email = email;
      if (typeof phone === "string" && phone.length > 0) {
        body.phone = phone;
        if (!options || typeof options !== "object" || !("channel" in options)) {
          body.channel = "sms";
        }
      }
      if (options && typeof options === "object") {
        Object.assign(body, options);
      }
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/otp",
        body,
        operation: "auth.signInOtp",
      });
    },

    async verifyOtp({ email, phone, token, type = "email" }) {
      // For phone OTP, GoTrue expects { phone, token, type: "sms" }.
      const body: Record<string, any> = { token, type };
      if (typeof email === "string" && email.length > 0) body.email = email;
      if (typeof phone === "string" && phone.length > 0) body.phone = phone;
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/verify",
        body,
        operation: "auth.verifyOtp",
      });
    },

    async signOut({ accessToken }) {
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/logout",
        bearerToken: accessToken,
        body: null,
        operation: "auth.signOut",
      });
    },

    async updateUser({ accessToken, body }) {
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "PUT",
        path: "/auth/v1/user",
        bearerToken: accessToken,
        body: body ?? {},
        operation: "auth.updateUser",
      });
    },

    // Sign in (or sign up) with an OIDC ID token from a native provider.
    // GoTrue's `grant_type=id_token` endpoint verifies the token signature
    // against the provider, then mints / returns a Supabase session.
    async signInWithIdToken({ provider, idToken, nonce, accessToken }) {
      const body: any = { provider, id_token: idToken };
      if (nonce) body.nonce = nonce;
      // When a bearer is forwarded, GoTrue links the OIDC identity to the
      // existing (e.g. anonymous) user instead of minting a new one — this
      // backs the anonymous → Apple upgrade flow.
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/token?grant_type=id_token",
        bearerToken: accessToken,
        body,
        operation: "auth.signInWithIdToken",
      });
    },

    async signInWithPassword({ email, password }) {
      return goTrueRequest({
        fetchImpl, supabaseUrl, apiKey: publishableKey,
        method: "POST", path: "/auth/v1/token?grant_type=password",
        body: { email, password }, operation: "auth.signInWithPassword",
      });
    },

    async signUp({ email, password }) {
      return goTrueRequest({
        fetchImpl, supabaseUrl, apiKey: publishableKey,
        method: "POST", path: "/auth/v1/signup",
        body: { email, password }, operation: "auth.signUp",
      });
    },

    oauthAuthorizeUrl({ provider, redirect, codeChallenge }) {
      const u = new URL(`${supabaseUrl}/auth/v1/authorize`);
      u.searchParams.set("provider", provider);
      u.searchParams.set("redirect_to", redirect);
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "s256");
      return u.toString();
    },

    async exchangePkceCode({ code, codeVerifier }) {
      return goTrueRequest({
        fetchImpl, supabaseUrl, apiKey: publishableKey,
        method: "POST", path: "/auth/v1/token?grant_type=pkce",
        body: { auth_code: code, code_verifier: codeVerifier },
        operation: "auth.exchangePkceCode",
      });
    },
  };
}

async function goTrueRequest({
  fetchImpl,
  supabaseUrl,
  apiKey,
  method,
  path,
  body,
  bearerToken = undefined,
  operation,
}: any) {
  const headers: any = {
    "Content-Type": "application/json",
    apikey: apiKey,
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const init: any = { method, headers };
  if (body !== undefined && body !== null) {
    init.body = JSON.stringify(body);
  } else if (method !== "GET" && method !== "HEAD") {
    init.body = "{}";
  }
  const res = await fetchImpl(`${supabaseUrl}${path}`, init);

  // Logout returns 204 No Content on success.
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!res.ok) {
    const message = parsed?.msg || parsed?.message || parsed?.error_description || parsed?.error || text || `GoTrue ${path} failed`;
    const code = res.status === 401 ? "missing_auth" : res.status === 422 ? "validation_failed" : "upstream_unavailable";
    throw new ApiError(res.status, code, `${operation}: ${message}`, { details: parsed });
  }

  return parsed ?? {};
}

function outgoingMessageRow(sessionId, input) {
  const row: any = {
    id: input.id,
    team_id: input.teamId,
    session_id: sessionId,
    sender_actor_id: input.senderActorId,
    kind: input.kind ?? "text",
    content: input.content,
    // Column is `jsonb not null default '{}'`. An explicit NULL bypasses the
    // default and trips the not-null constraint, so default to {} here (mirrors
    // the pg-repo backend). iOS sends no metadata when a message has no mentions.
    metadata: input.metadata ?? {},
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
    shareMode: row?.share_mode ?? null,
    shareEnabledAt: row?.share_enabled_at ?? null,
    gitRemoteUrl: row?.git_remote_url ?? null,
    gitAuthKind: row?.git_auth_kind ?? null,
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

function mapWorkspace(row) {
  const path = row?.path ?? null;
  return {
    id: requiredString(row?.id, "workspaces.mapWorkspace", "id"),
    teamId: requiredString(row?.team_id, "workspaces.mapWorkspace", "team_id"),
    name: requiredString(row?.name, "workspaces.mapWorkspace", "name"),
    path,
    slug: path,
    agentId: row?.agent_id ?? null,
    createdByMemberId: row?.created_by_member_id ?? null,
    archived: row?.archived === true,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function requiredInteger(value, operation, field) {
  if (Number.isInteger(value)) return value;
  throw new ApiError(502, "upstream_unavailable", `${operation} returned invalid ${field}`);
}

function mapShortcut(row) {
  return mapShortcutRow(row);
}

function mapTeamRole(row) {
  return {
    id: requiredString(row?.id, "roles.mapTeamRole", "id"),
    teamId: requiredString(row?.team_id, "roles.mapTeamRole", "team_id"),
    code: requiredString(row?.code, "roles.mapTeamRole", "code"),
    name: requiredString(row?.name, "roles.mapTeamRole", "name"),
  };
}

function mapPermission(row) {
  return {
    resourceId: requiredString(row?.resource_id, "permissions.mapPermission", "resource_id"),
    roleIds: (row?.permission_roles ?? []).map((x) => requiredString(x?.role_id, "permissions.mapPermission", "role_id")),
  };
}

function mapActor(row) {
  return {
    id: requiredString(row?.id, "actors.mapActor", "id"),
    teamId: requiredString(row?.team_id, "actors.mapActor", "team_id"),
    kind: row?.kind ?? "user",
    displayName: row?.display_name ?? "",
    avatarUrl: row?.avatar_url ?? null,
    metadata: row?.metadata ?? null,
  };
}

function mapTeamMember(row) {
  return {
    actorId: requiredString(row?.actor_id, "teamMembers.mapTeamMember", "actor_id"),
    teamId: requiredString(row?.team_id, "teamMembers.mapTeamMember", "team_id"),
    role: row?.role ?? "member",
    joinedAt: row?.joined_at ?? null,
  };
}

function mapIdeaRow(row) {
  return {
    id: requiredString(row?.id, "ideas.mapIdeaRow", "id"),
    teamId: requiredString(row?.team_id, "ideas.mapIdeaRow", "team_id"),
    title: requiredString(row?.title, "ideas.mapIdeaRow", "title"),
    description: row?.description ?? null,
    archived: row?.archived === true,
    authorActorId: row?.author_actor_id ?? null,
    actorIds: row?.actor_ids ?? [],
    // Fields the ideas table carries that clients (iOS IdeaStore) depend on.
    workspaceId: row?.workspace_id ?? null,
    status: row?.status ?? null,
    sortOrder: row?.sort_order ?? 0,
    createdByActorId: row?.created_by_actor_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapShortcutRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    scope: row.scope,
    label: row.label,
    owner_member_id: row.owner_member_id ?? null,
    team_id: row.team_id ?? null,
    parent_id: row.parent_id ?? null,
    icon: row.icon ?? null,
    order: row.order ?? 0,
    node_type: row.node_type,
    target: row.target ?? "",
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function mapAgentRuntimeRow(row) {
  return {
    id: requiredString(row?.id, "agentRuntimes.mapAgentRuntimeRow", "id"),
    agentActorId: requiredString(row?.agent_id, "agentRuntimes.mapAgentRuntimeRow", "agent_id"),
    sessionId: row?.session_id ?? null,
    runtimeId: row?.runtime_id ?? null,
    backendSessionId: row?.backend_session_id ?? null,
    teamId: row?.team_id ?? null,
    backendType: row?.backend_type ?? null,
    status: row?.status ?? null,
    workspaceId: row?.workspace_id ?? null,
    currentModel: row?.current_model ?? null,
    lastSeenAt: row?.last_seen_at ?? null,
    lastProcessedMessageId: row?.last_processed_message_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapIdeaActivityRow(row) {
  const kind = row?.kind ?? row?.activity_type;
  return {
    id: requiredString(row?.id, "ideas.mapIdeaActivityRow", "id"),
    ideaId: requiredString(row?.idea_id, "ideas.mapIdeaActivityRow", "idea_id"),
    kind: requiredString(kind, "ideas.mapIdeaActivityRow", "kind"),
    // Expose `activityType` alongside `kind` for clients that key on it.
    activityType: kind,
    content: row?.content ?? null,
    actorId: requiredString(row?.actor_id, "ideas.mapIdeaActivityRow", "actor_id"),
    metadata: row?.metadata ?? null,
    teamId: row?.team_id ?? null,
    attachmentUrls: row?.attachment_urls ?? [],
    createdAt: requiredString(row?.created_at, "ideas.mapIdeaActivityRow", "created_at"),
    updatedAt: row?.updated_at ?? null,
  };
}

function mapFeedbackRow(row) {
  return {
    messageId: requiredString(row?.message_id, "feedback.mapFeedbackRow", "message_id"),
    actorId: requiredString(row?.actor_id, "feedback.mapFeedbackRow", "actor_id"),
    teamId: row?.team_id ?? null,
    sessionId: row?.session_id ?? null,
    kind: requiredString(row?.kind, "feedback.mapFeedbackRow", "kind"),
    starRating: row?.star_rating ?? null,
    skill: row?.skill ?? null,
    createdAt: row?.created_at ?? null,
  };
}

function mapLeaderboardRow(row) {
  return {
    actorId: requiredString(row?.actor_id, "leaderboard.mapLeaderboardRow", "actor_id"),
    teamId: row?.team_id ?? null,
    displayName: row?.display_name ?? null,
    period: requiredString(row?.period, "leaderboard.mapLeaderboardRow", "period"),
    tokensUsed: Number(row?.tokens_used ?? 0),
    costUsd: Number(row?.cost_usd ?? 0),
    positiveFeedback: Number(row?.positive_feedback ?? 0),
    negativeFeedback: Number(row?.negative_feedback ?? 0),
    sessionCount: Number(row?.session_count ?? 0),
    skillUsage: row?.skill_usage ?? {},
    score: Number(row?.score ?? 0),
  };
}
