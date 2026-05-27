import type { ServerConfig } from "@/lib/server-config";
import { createSupabaseBackend } from "../supabase";
import type {
  AuthClaimResult,
  MessageHistoryRow,
  OutgoingMessageInput,
  SessionListEntry,
  SessionListPage,
  SessionListCursor,
  TeamClawBackend,
  TeamSummary,
} from "../types";
import { createCloudApiClient, type CloudApiClient } from "./http";

type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

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

type CloudMessage = {
  id: string;
  teamId: string;
  sessionId: string;
  turnId: string | null;
  senderActorId: string | null;
  replyToMessageId: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  model: string | null;
  createdAt: string;
  updatedAt: string | null;
};

type CloudTeam = {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string | null;
};

export function hasCloudApiBackendConfig(config: ServerConfig): boolean {
  return Boolean(config.cloudApiUrl && config.supabaseUrl && config.supabaseAnonKey);
}

export function createCloudApiBackend(
  config: ServerConfig,
  options: { delegate?: TeamClawBackend; client?: CloudApiClient } = {},
): TeamClawBackend {
  const delegate = options.delegate ?? createSupabaseBackend();
  const client = options.client ?? createCloudApiClient({
    baseUrl: requiredCloudApiUrl(config),
    auth: delegate.auth,
  });

  return {
    ...delegate,
    kind: "cloud_api",
    auth: {
      ...delegate.auth,
      async claimInvite(token: string): Promise<AuthClaimResult> {
        return client.post<AuthClaimResult>("/v1/invites/claim", { token });
      },
    },
    teams: {
      ...delegate.teams,
      async listCurrentUserTeams(args = {}) {
        const limit = args.limit ?? 50;
        const page = await client.get<Page<CloudTeam>>(`/v1/teams?limit=${encodeURIComponent(String(limit))}`);
        return page.items.map(mapTeam);
      },
      async getTeam(teamId: string) {
        return mapTeam(await client.get<CloudTeam>(`/v1/teams/${encodeURIComponent(teamId)}`));
      },
      async createTeam(input) {
        return mapTeam(await client.post<CloudTeam>("/v1/teams", input));
      },
    },
    sessions: {
      ...delegate.sessions,
      async listCurrentActorSessions(args: { limit: number; cursor: SessionListCursor | null }): Promise<SessionListPage> {
        const params = new URLSearchParams({ limit: String(args.limit) });
        if (args.cursor) params.set("cursor", encodeCursor(args.cursor));
        const page = await client.get<Page<CloudSession>>(`/v1/sessions?${params.toString()}`);
        return { rows: page.items.map(mapSession) };
      },
    },
    messages: {
      ...delegate.messages,
      async listMessages(sessionId: string): Promise<MessageHistoryRow[]> {
        const page = await client.get<Page<CloudMessage>>(
          `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        );
        return page.items.map(mapMessage);
      },
      async insertOutgoingMessage(input: OutgoingMessageInput): Promise<MessageHistoryRow> {
        const message = await client.post<CloudMessage>(
          `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages`,
          {
            id: input.id,
            teamId: input.teamId,
            senderActorId: input.senderActorId,
            content: input.content,
            kind: input.kind,
            metadata: input.metadata,
            turnId: input.turnId,
            replyToMessageId: input.replyToMessageId,
            model: input.model,
            createdAt: input.createdAt,
          },
          { idempotencyKey: input.id },
        );
        return mapMessage(message);
      },
    },
  };
}

function requiredCloudApiUrl(config: ServerConfig): string {
  if (!config.cloudApiUrl) throw new Error("Cloud API URL is not configured.");
  return config.cloudApiUrl;
}

function mapTeam(row: CloudTeam): TeamSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt,
  };
}

function mapSession(row: CloudSession): SessionListEntry {
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

function mapMessage(row: CloudMessage): MessageHistoryRow {
  return {
    id: row.id,
    team_id: row.teamId,
    session_id: row.sessionId,
    turn_id: row.turnId,
    sender_actor_id: row.senderActorId,
    reply_to_message_id: row.replyToMessageId,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata,
    model: row.model,
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
