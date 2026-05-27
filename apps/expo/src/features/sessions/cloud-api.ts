import type { createSessionsApi } from "./session-api";
import type { SessionMessage, SessionSummary } from "./session-types";

type SessionsApi = ReturnType<typeof createSessionsApi>;

type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

type CloudSession = {
  id: string;
  teamId: string;
  title: string;
  mode: string;
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
  metadata: unknown | null;
  model: string | null;
  createdAt: string;
  updatedAt: string | null;
};

export function createCloudSessionsApi(args: {
  baseUrl: string;
  delegate: SessionsApi;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): SessionsApi {
  const client = createCloudClient(args);

  return {
    ...args.delegate,
    async listSessions(teamId: string): Promise<SessionSummary[]> {
      const page = await client.get<Page<CloudSession>>("/v1/sessions?limit=50");
      return page.items
        .filter((row) => row.teamId === teamId)
        .map(mapSession);
    },
    async listMessages(_teamId: string, sessionId: string): Promise<SessionMessage[]> {
      const page = await client.get<Page<CloudMessage>>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      return page.items.map(mapMessage);
    },
    async insertOutgoingMessage(input): Promise<void> {
      if (!input.id) throw new Error("Cloud API message insert requires a stable message id.");
      await client.post(
        `/v1/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        {
          id: input.id,
          teamId: input.teamId,
          senderActorId: input.senderActorId,
          content: input.content,
          metadata: input.metadata ?? null,
          model: input.model ?? null,
          turnId: input.turnId ?? null,
          replyToMessageId: input.replyToMessageId ?? null,
          createdAt: input.createdAt,
        },
        { idempotencyKey: input.id },
      );
    },
  };
}

function createCloudClient(args: {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}) {
  const baseUrl = args.baseUrl.replace(/\/+$/, "");
  const fetchImpl = args.fetchImpl ?? fetch;

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const token = await args.getAccessToken();
    if (!token) throw new Error("Missing auth session access token.");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Request-Id": createRequestId(),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? "Cloud API request failed.");
    }
    return payload as T;
  }

  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body: unknown, options?: { idempotencyKey?: string }) =>
      request<T>("POST", path, body, options),
  };
}

function mapSession(row: CloudSession): SessionSummary {
  return {
    sessionId: row.id,
    teamId: row.teamId,
    title: row.title,
    summary: "",
    participantCount: 0,
    participantActorIds: [],
    lastMessagePreview: row.lastMessagePreview ?? "",
    lastMessageAt: row.lastMessageAt ?? "",
    createdAt: row.createdAt ?? "",
    createdBy: "",
    hasUnread: row.hasUnread,
  };
}

function mapMessage(row: CloudMessage): SessionMessage {
  return {
    content: row.content,
    createdAt: row.createdAt,
    kind: row.kind,
    messageId: row.id,
    metadata: row.metadata,
    model: row.model ?? "",
    replyToMessageId: row.replyToMessageId ?? "",
    senderActorId: row.senderActorId ?? "",
    sessionId: row.sessionId,
    teamId: row.teamId,
    turnId: row.turnId ?? "",
  };
}

function createRequestId(): string {
  return Math.random().toString(36).slice(2).padEnd(12, "0").slice(0, 12);
}
