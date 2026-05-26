import type { ShortcutsBackend } from "../types";
import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";

type QueryResult<T = unknown> = Promise<{ data: T; error: unknown | null }>;

type SupabaseShortcutsClient = {
  from(table: string): {
    select(columns: string): unknown;
    update(patch: Record<string, unknown>): { eq(column: string, value: unknown): Promise<{ error: unknown | null }> };
    delete(): { eq(column: string, value: unknown): Promise<{ error: unknown | null }> };
  };
  rpc(name: string, args: Record<string, unknown>): QueryResult;
};

function requireShortcutId(data: unknown): string {
  if (typeof data === "string" && data.trim() !== "") return data;
  throw toBackendError({ message: "shortcut_create returned an empty id" }, "shortcuts.createShortcut");
}

export function createSupabaseShortcutsBackend(client: unknown = defaultSupabase): ShortcutsBackend {
  const supabase = client as SupabaseShortcutsClient;

  return {
    async listShortcuts(scope, teamId) {
      let query = supabase.from("shortcuts").select("*") as {
        eq(column: string, value: unknown): unknown;
        order(column: string, options: { ascending: boolean }): QueryResult<Array<Record<string, unknown>>>;
      };
      query = query.eq("scope", scope) as typeof query;
      if (scope === "team" && teamId) query = query.eq("team_id", teamId) as typeof query;
      const { data, error } = await query.order("order", { ascending: true });
      if (error) throw toBackendError(error, "shortcuts.listShortcuts");
      return (data ?? []) as unknown as Awaited<ReturnType<ShortcutsBackend["listShortcuts"]>>;
    },
    async createShortcut(input) {
      const args = {
        p_scope: input.p_scope,
        p_label: input.p_label,
        p_node_type: input.p_node_type,
        p_team_id: input.p_scope === "team" ? (input.p_team_id ?? null) : null,
        p_parent_id: input.p_parent_id ?? null,
        p_icon: input.p_icon ?? null,
        p_order: input.p_order ?? 0,
        p_target: input.p_target ?? "",
      };
      const { data, error } = await supabase.rpc("shortcut_create", args);
      if (error) throw toBackendError(error, "shortcuts.createShortcut");
      return { id: requireShortcutId(data) };
    },
    async updateShortcut(id, patch) {
      const { error } = await supabase.from("shortcuts").update(patch).eq("id", id);
      if (error) throw toBackendError(error, "shortcuts.updateShortcut");
    },
    async deleteShortcut(id) {
      const { error } = await supabase.from("shortcuts").delete().eq("id", id);
      if (error) throw toBackendError(error, "shortcuts.deleteShortcut");
    },
    async batchMove(input) {
      const { data, error } = await supabase.rpc("shortcut_batch_move", input);
      if (error) throw toBackendError(error, "shortcuts.batchMove");
      return data;
    },
    async setVisibleRoles(input) {
      const { error } = await supabase.rpc("shortcut_set_visible_roles", input);
      if (error) throw toBackendError(error, "shortcuts.setVisibleRoles");
    },
    async listTeamRoles(teamId) {
      const query = supabase.from("team_roles").select("id, team_id, code, name") as {
        eq(column: string, value: unknown): {
          order(column: string, options: { ascending: boolean }): QueryResult<Array<Record<string, unknown>>>;
        };
      };
      const { data, error } = await query.eq("team_id", teamId).order("code", { ascending: true });
      if (error) throw toBackendError(error, "shortcuts.listTeamRoles");
      return (data ?? []) as unknown as Awaited<ReturnType<ShortcutsBackend["listTeamRoles"]>>;
    },
    async listShortcutRoleBindings(teamId) {
      const query = supabase.from("permissions").select("resource_id, permission_roles(role_id)") as {
        eq(column: string, value: unknown): unknown;
      };
      const teamQuery = query.eq("team_id", teamId) as typeof query;
      const { data, error } = (await teamQuery.eq("resource_type", "shortcut")) as Awaited<
        QueryResult<Array<Record<string, unknown>>>
      >;
      if (error) throw toBackendError(error, "shortcuts.listShortcutRoleBindings");
      return (data ?? []) as unknown as Awaited<ReturnType<ShortcutsBackend["listShortcutRoleBindings"]>>;
    },
  };
}
