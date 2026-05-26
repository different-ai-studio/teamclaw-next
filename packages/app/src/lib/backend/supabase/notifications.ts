import type { NotificationsBackend } from "../types";

function notImplemented(operation: string): never {
  throw new Error(`${operation} backend not implemented`);
}

export function createSupabaseNotificationsBackend(_client: unknown): NotificationsBackend {
  return {
    loadPreferences: async () => notImplemented("notifications.loadPreferences"),
    savePreferences: async () => notImplemented("notifications.savePreferences"),
    setSessionMuted: async () => notImplemented("notifications.setSessionMuted"),
    listMutedSessionIds: async () => notImplemented("notifications.listMutedSessionIds"),
  };
}
