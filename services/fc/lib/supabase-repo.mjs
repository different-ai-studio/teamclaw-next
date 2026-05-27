import { randomUUID } from "node:crypto";
import { createClient as defaultCreateClient } from "@supabase/supabase-js";
import { ApiError } from "./http-utils.mjs";

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
        .select("user_id, push_enabled, email_enabled, digest_frequency")
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        return {
          userId: null,
          pushEnabled: true,
          emailEnabled: false,
          digestFrequency: "off",
        };
      }
      return {
        userId: requiredString(row.user_id, "notifications.getNotificationPrefs", "user_id"),
        pushEnabled: row.push_enabled ?? true,
        emailEnabled: row.email_enabled ?? false,
        digestFrequency: row.digest_frequency ?? "off",
      };
    },

    async putNotificationPrefs(input) {
      const row = {
        user_id: input.userId,
        push_enabled: input.pushEnabled,
        email_enabled: input.emailEnabled,
        digest_frequency: input.digestFrequency,
      };
      const { data, error } = await supabase
        .from("notification_prefs")
        .upsert(row, { onConflict: "user_id" })
        .select("user_id, push_enabled, email_enabled, digest_frequency")
        .single();
      if (error) throw error;
      return {
        userId: requiredString(data.user_id, "notifications.putNotificationPrefs", "user_id"),
        pushEnabled: data.push_enabled ?? true,
        emailEnabled: data.email_enabled ?? false,
        digestFrequency: data.digest_frequency ?? "off",
      };
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
  } = options;

  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!publishableKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is required");

  return {
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
  };
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
