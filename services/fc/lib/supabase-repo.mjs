import { randomUUID } from "node:crypto";
import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { ApiError } from "./http-utils.mjs";

// FC runtime is Node 20 which lacks native WebSocket. supabase-js v2.45+ tries
// to construct a RealtimeClient at createClient() time and throws without a
// transport. We never use Realtime in FC; pass `ws` so the construction
// succeeds. The transport is only opened lazily when realtime channels are
// subscribed, which we never do.
const REALTIME_TRANSPORT_OPTS = { transport: WebSocket };

const ATTACHMENTS_BUCKET = "attachments";
const TEAM_COLUMNS = "id, name, slug, created_at";
const MESSAGE_COLUMNS =
  "id, team_id, session_id, turn_id, sender_actor_id, reply_to_message_id, kind, content, metadata, model, created_at, updated_at";
const WORKSPACE_COLUMNS = "id, team_id, name, slug, archived, metadata, created_at, updated_at";

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
    realtime: REALTIME_TRANSPORT_OPTS,
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

    async renameTeam(teamId, { name }) {
      const { data, error } = await supabase.rpc("rename_team", { p_team_id: teamId, p_name: name });
      if (error) throw error;
      return mapTeam(requiredRow(data, "teams.renameTeam"));
    },

    async createTeamInvite(teamId, input) {
      const args = {
        p_team_id: teamId,
        p_actor_type: input.actorType,
        p_display_name: input.displayName,
      };
      if (input.role !== undefined) args.p_role = input.role;
      if (input.expiresAt !== undefined) args.p_expires_at = input.expiresAt;
      const { data, error } = await supabase.rpc("create_team_invite", args);
      if (error) throw error;
      const row = requiredRow(data, "teams.createTeamInvite");
      return {
        token: requiredString(row.token, "teams.createTeamInvite", "token"),
        inviteId: requiredString(row.invite_id, "teams.createTeamInvite", "invite_id"),
        expiresAt: row.expires_at ?? null,
      };
    },

    async removeTeamActor(teamId, actorId) {
      const { error } = await supabase.rpc("remove_team_actor", { p_team_id: teamId, p_actor_id: actorId });
      if (error) throw error;
    },

    async listTeamActors(teamId, { kind = null, limit = 500 } = {}) {
      let query = supabase
        .from("actor_directory")
        .select(
          "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at",
        )
        .eq("team_id", teamId);
      if (kind) query = query.eq("actor_type", kind);
      query = query.order("last_active_at", { ascending: false, nullsFirst: false })
                   .order("display_name", { ascending: true })
                   .limit(limit);
      const { data, error } = await query;
      if (error) throw error;
      return { items: data ?? [] };
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
      const row = {};
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

    async listWorkspaces({ teamId, limit = 50, cursor = null } = {}) {
      let query = supabase
        .from("workspaces")
        .select(WORKSPACE_COLUMNS)
        .eq("team_id", teamId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
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
        slug: input.slug ?? null,
        archived: input.archived ?? false,
        metadata: input.metadata ?? null,
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
      const row = {};
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.archived !== undefined) row.archived = patch.archived;
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
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

async heartbeat() {
      const { error } = await supabase.rpc("heartbeat");
      if (error) throw error;
    },

    async listShortcuts(teamId, { parentId } = {}) {
      let query = supabase
        .from("shortcuts")
        .select("*")
        .eq("scope", "team")
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
      return (data ?? []).map(mapShortcut);
    },

    async listShortcutsByScope({ scope, teamId, parentId } = {}) {
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

    async createShortcut(input) {
      const args = {
        p_team_id: input.teamId,
        p_kind: input.kind,
        p_label: input.label,
      };
      if (input.id !== undefined) args.p_id = input.id;
      if (input.parentId !== undefined) args.p_parent_id = input.parentId;
      if (input.payload !== undefined) args.p_payload = input.payload;
      if (input.position !== undefined) args.p_position = input.position;
      if (input.visibleRoleIds !== undefined) args.p_visible_role_ids = input.visibleRoleIds;
      const { data, error } = await supabase.rpc("shortcut_create", args);
      if (error) throw error;
      const id = requiredString(data, "shortcuts.createShortcut", "id");
      return this.getShortcut(id);
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
      return mapShortcut(data);
    },

    async updateShortcut(shortcutId, patch) {
      const row = {};
      if (patch.parentId !== undefined) row.parent_id = patch.parentId;
      if (patch.label !== undefined) row.label = patch.label;
      if (patch.payload !== undefined) row.payload = patch.payload;
      if (patch.position !== undefined) row.position = patch.position;
      if (patch.visibleRoleIds !== undefined) row.visible_role_ids = patch.visibleRoleIds;
      const { data, error } = await supabase
        .from("shortcuts")
        .update(row)
        .eq("id", shortcutId)
        .select("*")
        .single();
      if (error) {
        if (error.code === "PGRST116") return null;
        throw error;
      }
      return mapShortcut(data);
    },

    async deleteShortcut(shortcutId) {
      const { error } = await supabase
        .from("shortcuts")
        .delete()
        .eq("id", shortcutId);
      if (error) throw error;
    },

    async batchMoveShortcuts({ moves }) {
      const formattedMoves = moves.map((m) => ({
        shortcut_id: m.shortcutId,
        parent_id: m.parentId,
        position: m.position,
      }));
      const { error } = await supabase.rpc("shortcut_batch_move", {
        p_moves: formattedMoves,
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
      return (data ?? []).map(mapTeamRole);
    },

    async listTeamPermissions(teamId) {
      const { data, error } = await supabase
        .from("permissions")
        .select("resource_id, permission_roles(role_id)")
        .eq("team_id", teamId);
      if (error) throw error;
      return (data ?? []).map(mapPermission);
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

    async putNotificationPrefs(input) {
      // Accept snake_case from the frontend (matches the on-disk row shape).
      const row = {
        user_id: input.user_id,
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

    async listIdeas({ teamId, archived = false, limit = 50, cursor = null } = {}) {
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
      const args = {
        p_team_id: body.teamId,
        p_title: body.title,
        p_description: body.description ?? null,
        p_author_actor_id: body.authorActorId,
        p_actor_ids: body.actorIds ?? [],
      };
      if (body.id !== undefined) args.p_id = body.id;
      const { data, error } = await supabase.rpc("create_idea", args);
      if (error) throw error;
      const id = requiredString(data, "ideas.createIdea", "id");
      return this.getIdea(id);
    },

    async updateIdea(ideaId, body) {
      const { error } = await supabase.rpc("update_idea", {
        p_idea_id: ideaId,
        p_title: body.title ?? null,
        p_description: body.description ?? null,
        p_actor_ids: body.actorIds ?? null,
      });
      if (error) throw error;
      return this.getIdea(ideaId);
    },

    async archiveIdea(ideaId) {
      const { error } = await supabase.rpc("archive_idea", { p_idea_id: ideaId });
      if (error) throw error;
    },

    async listShortcuts(teamId, { parentId } = {}) {
      let query = supabase
        .from("shortcuts")
        .select("*")
        .eq("team_id", teamId)
        .order("position", { ascending: true });
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
        p_team_id: body.teamId,
        p_kind: body.kind,
        p_label: body.label,
        p_parent_id: body.parentId ?? null,
        p_payload: body.payload ?? null,
        p_position: body.position ?? 0,
        p_visible_role_ids: body.visibleRoleIds ?? [],
      };
      if (body.id !== undefined) args.p_id = body.id;
      const { data, error } = await supabase.rpc("shortcut_create", args);
      if (error) throw error;
      const id = requiredString(data, "shortcuts.createShortcut", "id");
      return this.getShortcut(id);
    },

    async updateShortcut(shortcutId, patch) {
      const body = {};
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
        p_kind: body.kind,
        p_content: body.content ?? null,
        p_actor_id: body.actorId,
        p_metadata: body.metadata ?? null,
      });
      if (error) throw error;
      return mapIdeaActivityRow(requiredRow(data, "ideas.createIdeaActivity"));
    },

    async upsertAgentRuntime(body) {
      const row = {
        id: body.id ?? randomUUID(),
        agent_actor_id: body.agentActorId,
        session_id: body.sessionId,
        runtime_id: body.runtimeId,
        backend_session_id: body.backendSessionId,
        metadata: body.metadata ?? null,
      };
      const { data, error } = await supabase
        .from("agent_runtimes")
        .upsert(row, { onConflict: "session_id,runtime_id,backend_session_id" })
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
        .eq("agent_actor_id", agentId)
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
      const { error } = await supabase.rpc("ensure_agent_types", {
        p_supported_types: supportedTypes,
        p_default_agent_type: defaultAgentType,
      });
      if (error) throw error;
    },

    async setAgentDeviceId(agentActorId, { deviceId }) {
      const { error } = await supabase
        .from("agents")
        .update({ device_id: deviceId })
        .eq("actor_id", agentActorId);
      if (error) throw error;
    },

    async uploadAttachment({ path, mime, bytes }) {
      const { error } = await supabase.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(path, bytes, { contentType: mime, upsert: true });
      if (error) throw error;
      return {
        path,
        url: `${supabaseUrl}/storage/v1/object/public/${ATTACHMENTS_BUCKET}/${path}`,
      };
    },

    async downloadAttachment(path) {
      const { data, error } = await supabase.storage
        .from(ATTACHMENTS_BUCKET)
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
        kind: body.kind,
        star_rating: body.starRating ?? null,
        note: body.note ?? null,
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
        .from("team_leaderboard")
        .select("*")
        .eq("team_id", teamId)
        .eq("period", period)
        .order("score", { ascending: false });
      if (error) throw error;
      return { items: (data ?? []).map(mapLeaderboardRow) };
    },

    // --- Directory resolution (frontend supabase delegate parity) ---

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
        .select(
          "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at",
        )
        .in("id", actorIds);
      if (teamId) q = q.eq("team_id", teamId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
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
      const insertRow = {
        id,
        team_id: input.teamId,
        title: input.title,
        mode: input.mode ?? "collab",
        idea_id: input.ideaId ?? null,
      };
      if (input.createdByActorId) insertRow.created_by_actor_id = input.createdByActorId;
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
            input.createdByActorId,
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
      const update = {};
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

    async getSessionByAcp(acpSessionId) {
      const { data, error } = await supabase
        .from("sessions")
        .select(SESSION_FULL_COLUMNS)
        .eq("acp_session_id", acpSessionId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapSessionFull(data) : null;
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
      return {
        sessionId: row.session_id ?? row.sessionId ?? null,
        acpSessionId: row.acp_session_id ?? row.acpSessionId ?? null,
        created: row.created === true,
      };
    },

    async createCronSession(input) {
      // Cron sessions are plain `mode='collab'` sessions with no idea_id and
      // a marker in `summary` or metadata. The supabase create_session RPC
      // requires an idea_id, so we insert directly to bypass that constraint.
      const id = input.id ?? randomUUID();
      const insertRow = {
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
      return { sessionId: data.id, ...mapSessionFull(data) };
    },

    // --- Session members (participants) ---

    async listSessionParticipants(sessionId) {
      const { data, error } = await supabase
        .from("session_participants")
        .select("session_id, actor_id, role, joined_at")
        .eq("session_id", sessionId);
      if (error) throw error;
      const items = (data ?? []).map((row) => ({
        sessionId: row.session_id,
        actorId: row.actor_id,
        role: row.role ?? null,
        joinedAt: row.joined_at ?? null,
      }));
      return { items };
    },

    async upsertSessionParticipant(sessionId, input) {
      const row = {
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
      return data ? mapDirectoryActor(data) : null;
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
      // Lightweight no-op probe: confirms the caller's JWT can still talk to
      // PostgREST. We query a row count from `teams` (RLS-scoped to the
      // caller) and ignore the result. Errors propagate so the FC handler
      // can return 5xx if the upstream is down.
      const { error } = await supabase
        .from("teams")
        .select("id", { head: true, count: "exact" })
        .limit(1);
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
          deviceId: row.device_id ?? null,
        };
      }).filter((row) => typeof row.id === "string" && row.id.length > 0);
      return { items };
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
      const memberNames = new Map();
      if (memberIds.length > 0) {
        const { data: members, error: memberError } = await supabase
          .from("actor_directory")
          .select("id, display_name")
          .in("id", memberIds);
        if (memberError) throw memberError;
        for (const member of members ?? []) {
          memberNames.set(member.id, member.display_name || member.id);
        }
      }
      const items = rows.map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        agentActorId: row.agent_id,
        actorId: row.member_id,
        memberId: row.member_id,
        memberName: memberNames.get(row.member_id) ?? row.member_id,
        role: row.permission_level,
        permissionLevel: row.permission_level,
        grantedByMemberId: row.granted_by_member_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
      return { items };
    },
  };
}

const SESSION_FULL_COLUMNS =
  "id, team_id, title, mode, idea_id, primary_agent_id, created_by_actor_id, summary, last_message_preview, last_message_at, acp_session_id, binding, created_at, updated_at";

const ACTOR_DIRECTORY_COLUMNS =
  "id, team_id, actor_type, user_id, display_name, avatar_url, team_role, member_status, agent_status, agent_types, default_agent_type, default_workspace_id, last_active_at, created_at, updated_at";

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
    teamRole: row?.team_role ?? null,
    memberStatus: row?.member_status ?? null,
    agentStatus: row?.agent_status ?? null,
    agentTypes: row?.agent_types ?? null,
    defaultAgentType: row?.default_agent_type ?? null,
    defaultWorkspaceId: row?.default_workspace_id ?? null,
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

  return {
    async claimInvite(token) {
      const { data, error } = await anonClient.rpc("claim_team_invite", { p_token: token });
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

    async signInOtp({ email, options }) {
      const body = { email };
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

    async verifyOtp({ email, token, type = "email" }) {
      return goTrueRequest({
        fetchImpl,
        supabaseUrl,
        apiKey: publishableKey,
        method: "POST",
        path: "/auth/v1/verify",
        body: { email, token, type },
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
  };
}

async function goTrueRequest({
  fetchImpl,
  supabaseUrl,
  apiKey,
  method,
  path,
  body,
  bearerToken,
  operation,
}) {
  const headers = {
    "Content-Type": "application/json",
    apikey: apiKey,
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const init = { method, headers };
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

function mapWorkspace(row) {
  return {
    id: requiredString(row?.id, "workspaces.mapWorkspace", "id"),
    teamId: requiredString(row?.team_id, "workspaces.mapWorkspace", "team_id"),
    name: requiredString(row?.name, "workspaces.mapWorkspace", "name"),
    slug: row?.slug ?? null,
    archived: row?.archived === true,
    metadata: row?.metadata ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function requiredInteger(value, operation, field) {
  if (Number.isInteger(value)) return value;
  throw new ApiError(502, "upstream_unavailable", `${operation} returned invalid ${field}`);
}

function mapShortcut(row) {
  return {
    id: requiredString(row?.id, "shortcuts.mapShortcut", "id"),
    teamId: requiredString(row?.team_id, "shortcuts.mapShortcut", "team_id"),
    parentId: row?.parent_id ?? null,
    kind: requiredString(row?.kind, "shortcuts.mapShortcut", "kind"),
    label: requiredString(row?.label, "shortcuts.mapShortcut", "label"),
    payload: row?.payload ?? null,
    position: row?.position ?? 0,
    visibleRoleIds: row?.visible_role_ids ?? [],
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
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
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapShortcutRow(row) {
  return {
    id: requiredString(row?.id, "shortcuts.mapShortcutRow", "id"),
    teamId: requiredString(row?.team_id, "shortcuts.mapShortcutRow", "team_id"),
    parentId: row?.parent_id ?? null,
    kind: requiredString(row?.kind, "shortcuts.mapShortcutRow", "kind"),
    label: requiredString(row?.label, "shortcuts.mapShortcutRow", "label"),
    payload: row?.payload ?? null,
    position: row?.position ?? 0,
    visibleRoleIds: row?.visible_role_ids ?? [],
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapAgentRuntimeRow(row) {
  return {
    id: requiredString(row?.id, "agentRuntimes.mapAgentRuntimeRow", "id"),
    agentActorId: requiredString(row?.agent_actor_id, "agentRuntimes.mapAgentRuntimeRow", "agent_actor_id"),
    sessionId: requiredString(row?.session_id, "agentRuntimes.mapAgentRuntimeRow", "session_id"),
    runtimeId: requiredString(row?.runtime_id, "agentRuntimes.mapAgentRuntimeRow", "runtime_id"),
    backendSessionId: requiredString(row?.backend_session_id, "agentRuntimes.mapAgentRuntimeRow", "backend_session_id"),
    lastProcessedMessageId: row?.last_processed_message_id ?? null,
    metadata: row?.metadata ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapIdeaActivityRow(row) {
  return {
    id: requiredString(row?.id, "ideas.mapIdeaActivityRow", "id"),
    ideaId: requiredString(row?.idea_id, "ideas.mapIdeaActivityRow", "idea_id"),
    kind: requiredString(row?.kind, "ideas.mapIdeaActivityRow", "kind"),
    content: row?.content ?? null,
    actorId: requiredString(row?.actor_id, "ideas.mapIdeaActivityRow", "actor_id"),
    metadata: row?.metadata ?? null,
    createdAt: requiredString(row?.created_at, "ideas.mapIdeaActivityRow", "created_at"),
  };
}

function mapFeedbackRow(row) {
  return {
    messageId: requiredString(row?.message_id, "feedback.mapFeedbackRow", "message_id"),
    actorId: requiredString(row?.actor_id, "feedback.mapFeedbackRow", "actor_id"),
    kind: requiredString(row?.kind, "feedback.mapFeedbackRow", "kind"),
    starRating: row?.star_rating ?? null,
    note: row?.note ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function mapLeaderboardRow(row) {
  return {
    actorId: requiredString(row?.actor_id, "leaderboard.mapLeaderboardRow", "actor_id"),
    teamId: row?.team_id ?? null,
    period: requiredString(row?.period, "leaderboard.mapLeaderboardRow", "period"),
    score: row?.score ?? 0,
    rank: row?.rank ?? null,
    displayName: row?.display_name ?? null,
  };
}
