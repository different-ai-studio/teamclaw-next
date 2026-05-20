import type { Shortcut, ShortcutNodeType, ShortcutScope } from "./shortcut-types";

type SupabaseError = { message?: string } | null;
type QueryResult<T> = { data: T; error: SupabaseError };
type ShortcutsClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};

type ShortcutRow = {
  id: string;
  label: string | null;
  icon: string | null;
  node_type: string | null;
  target: string | null;
  order: number | null;
  parent_id: string | null;
  scope: string | null;
};

function throwIfError(error: SupabaseError) {
  if (error?.message) throw new Error(error.message);
}

function toNodeType(value: string | null): ShortcutNodeType {
  switch (value) {
    case "folder":
    case "team":
    case "session":
    case "external":
      return value;
    case "url":
    default:
      return "url";
  }
}

function toScope(value: string | null): ShortcutScope {
  return value === "team" ? "team" : "personal";
}

function toShortcut(row: ShortcutRow): Shortcut {
  return {
    id: row.id,
    label: row.label?.trim() || "Shortcut",
    icon: row.icon ?? null,
    nodeType: toNodeType(row.node_type),
    target: row.target ?? null,
    order: row.order ?? 0,
    parentId: row.parent_id ?? null,
    scope: toScope(row.scope),
  };
}

export function createShortcutsApi(client: ShortcutsClient) {
  return {
    async listShortcuts(teamId: string): Promise<Shortcut[]> {
      const result = (await client
        .from("shortcuts")
        .select("id, label, icon, node_type, target, \"order\", parent_id, scope")
        .eq("team_id", teamId)
        .order("order", { ascending: true })) as QueryResult<ShortcutRow[] | null>;
      throwIfError(result.error);
      return (result.data ?? []).map(toShortcut);
    },

    async renameShortcut(id: string, label: string): Promise<void> {
      const result = (await client
        .from("shortcuts")
        .update({ label, updated_at: new Date().toISOString() })
        .eq("id", id)) as QueryResult<null>;
      throwIfError(result.error);
    },

    async deleteShortcut(id: string): Promise<void> {
      const result = (await client
        .from("shortcuts")
        .delete()
        .eq("id", id)) as QueryResult<null>;
      throwIfError(result.error);
    },
  };
}
