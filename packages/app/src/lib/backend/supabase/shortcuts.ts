import type { ShortcutsBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseShortcutsBackend(_client: unknown): ShortcutsBackend {
  return {
    listShortcuts: async () => notImplemented("shortcuts.listShortcuts"),
    createShortcut: async () => notImplemented("shortcuts.createShortcut"),
    updateShortcut: async () => notImplemented("shortcuts.updateShortcut"),
    deleteShortcut: async () => notImplemented("shortcuts.deleteShortcut"),
    batchMove: async () => notImplemented("shortcuts.batchMove"),
    setVisibleRoles: async () => notImplemented("shortcuts.setVisibleRoles"),
  };
}
