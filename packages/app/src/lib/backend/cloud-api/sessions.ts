import type {
  SessionListCursor,
  SessionListPage,
  SessionsBackend,
} from "../types";
import type { CloudApiClient } from "./http";

type CloudSession = {
  id: string;
  teamId: string;
  title: string;
  mode: "solo" | "collab" | "control";
  ideaId: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  hasUnread: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type Page<T> = { items: T[]; nextCursor: string | null };

function mapSession(row: CloudSession) {
  return {
    id: row.id,
    title: row.title,
    team_id: row.teamId,
    last_message_at: row.lastMessageAt,
    last_message_preview: row.lastMessagePreview,
    mode: row.mode,
    idea_id: row.ideaId,
    has_unread: row.hasUnread,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function encodeCursor(cursor: SessionListCursor): string {
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createSessionsModule(client: CloudApiClient, delegate: SessionsBackend): SessionsBackend {
  return {
    ...delegate,
    async listCurrentActorSessions(args: { limit: number; cursor: SessionListCursor | null }): Promise<SessionListPage> {
      const params = new URLSearchParams({ limit: String(args.limit) });
      if (args.cursor) params.set("cursor", encodeCursor(args.cursor));
      const page = await client.get<Page<CloudSession>>(`/v1/sessions?${params.toString()}`);
      return { rows: page.items.map(mapSession) };
    },
    async markCurrentActorSessionViewed(sessionId: string, lastReadMessageId?: string | null) {
      await client.post<void>(`/v1/sessions/${encodeURIComponent(sessionId)}/mark-viewed`, { lastReadMessageId: lastReadMessageId ?? null });
    },
  };
}
