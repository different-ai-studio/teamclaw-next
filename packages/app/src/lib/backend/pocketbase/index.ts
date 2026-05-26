import type { ServerConfig } from "@/lib/server-config";
import type { TeamClawBackend } from "../types";
import type {
  ActorDirectoryEntry,
  ActorDirectorySyncRow,
  AuthSession,
  IdeaSyncRow,
  MessageHistoryRow,
  MessageSyncRow,
  SessionDisplayRow,
  SessionListEntry,
  SessionMemberCandidate,
  SessionParticipant,
  SessionSyncRow,
  TeamSummary,
} from "../types";
import { createUnsupportedPocketBaseService } from "./unsupported";
import { BackendError, toBackendError } from "../errors";

export const POCKETBASE_CONFIG_MISSING_MESSAGE =
  "PocketBase config missing. Configure a PocketBase URL before signing in.";

export function hasPocketBaseBackendConfig(config: ServerConfig): boolean {
  return Boolean(config.pocketbaseUrl?.trim());
}

type PocketBaseRecord = Record<string, unknown> & {
  id: string;
  created?: string;
  updated?: string;
  expand?: Record<string, unknown>;
};

type PocketBaseList<T> = {
  items: T[];
};

type StoredAuth = {
  token: string;
  record: PocketBaseRecord;
};

const AUTH_STORAGE_KEY = "teamclaw:pocketbase:auth";
const DEFAULT_PREVIEW_EMAIL = "preview+member@teamclaw.local";
const DEFAULT_PREVIEW_PASSWORD = "teamclaw-preview";

function nowIso(): string {
  return new Date().toISOString();
}

function quoteFilter(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeUrl(url: string | undefined): string {
  return (url ?? "").trim().replace(/\/+$/, "");
}

function getStoredAuth(): StoredAuth | null {
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    return parsed?.token && parsed?.record?.id ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredAuth(auth: StoredAuth | null): void {
  if (!globalThis.localStorage) return;
  if (!auth) globalThis.localStorage.removeItem(AUTH_STORAGE_KEY);
  else globalThis.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
}

function sessionFromAuth(auth: StoredAuth | null): AuthSession | null {
  if (!auth) return null;
  const exp = (() => {
    try {
      const [, payload] = auth.token.split(".");
      if (!payload) return null;
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(normalized)) as { exp?: unknown };
      return typeof json.exp === "number" ? json.exp : null;
    } catch {
      return null;
    }
  })();
  return {
    user: {
      ...auth.record,
      id: auth.record.id,
      email: typeof auth.record.email === "string" ? auth.record.email : null,
    },
    accessToken: auth.token,
    refreshToken: auth.token,
    expiresAt: exp,
    providerData: auth.record,
  };
}

function toPbError(status: number, body: unknown, operation: string): BackendError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return new BackendError({
    category: status === 401 ? "Unauthenticated" : status === 404 ? "NotFound" : status === 403 ? "Forbidden" : "Unknown",
    operation,
    message: typeof record.message === "string" ? record.message : `${operation} failed`,
    status,
    code: typeof record.code === "string" ? record.code : undefined,
    cause: body,
  });
}

function rowDate(row: PocketBaseRecord, field: "created" | "updated"): string {
  return typeof row[field] === "string" ? row[field] : nowIso();
}

function relationId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function mapActor(row: PocketBaseRecord): ActorDirectoryEntry {
  return {
    id: row.id,
    team_id: relationId(row.team) ?? "",
    display_name: typeof row.display_name === "string" ? row.display_name : null,
    actor_type: typeof row.actor_type === "string" ? row.actor_type : null,
    avatar_url: typeof row.avatar_url === "string" ? row.avatar_url : null,
    user_id: relationId(row.account),
    last_active_at: typeof row.last_active_at === "string" ? row.last_active_at : null,
    created_at: rowDate(row, "created"),
    updated_at: rowDate(row, "updated"),
    member_status: null,
    agent_status: typeof row.device_id === "string" && row.device_id ? "online" : null,
    team_role: typeof row.team_role === "string" ? row.team_role : null,
    agent_types: Array.isArray(row.agent_types) ? row.agent_types.filter((v): v is string => typeof v === "string") : null,
    default_agent_type: typeof row.default_agent_type === "string" ? row.default_agent_type : null,
    default_workspace_id: typeof row.default_workspace_id === "string" ? row.default_workspace_id : null,
  };
}

function mapTeam(row: PocketBaseRecord): TeamSummary {
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : "Untitled team",
    slug: typeof row.slug === "string" ? row.slug : null,
    created_at: rowDate(row, "created"),
  };
}

function mapSession(row: PocketBaseRecord): SessionListEntry {
  return {
    id: row.id,
    title: typeof row.title === "string" ? row.title : "Untitled",
    team_id: relationId(row.team) ?? "",
    last_message_at: typeof row.last_message_at === "string" ? row.last_message_at : null,
    last_message_preview: typeof row.last_message_preview === "string" ? row.last_message_preview : null,
    mode: row.mode === "solo" || row.mode === "control" ? row.mode : "collab",
    idea_id: typeof row.idea_id === "string" ? row.idea_id : null,
    has_unread: false,
    created_at: rowDate(row, "created"),
    updated_at: rowDate(row, "updated"),
  };
}

function mapMessage(row: PocketBaseRecord): MessageHistoryRow {
  return {
    id: row.id,
    team_id: relationId(row.team) ?? "",
    session_id: relationId(row.session) ?? "",
    turn_id: typeof row.turn_id === "string" ? row.turn_id : null,
    sender_actor_id: relationId(row.sender_actor),
    reply_to_message_id: typeof row.reply_to_message_id === "string" ? row.reply_to_message_id : null,
    kind: typeof row.kind === "string" ? row.kind : "text",
    content: typeof row.content === "string" ? row.content : "",
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : null,
    model: typeof row.model === "string" ? row.model : null,
    mentions: null,
    parts: null,
    attachments: Array.isArray(row.attachments) ? row.attachments as MessageHistoryRow["attachments"] : null,
    created_at: rowDate(row, "created"),
    updated_at: typeof row.updated === "string" ? row.updated : null,
  };
}

class PocketBaseRestClient {
  constructor(private readonly baseUrl: string) {}

  private authToken(): string | null {
    return getStoredAuth()?.token ?? null;
  }

  async request<T>(path: string, init: RequestInit = {}, operation = path): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
    const token = this.authToken();
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);

    const response = await fetch(`${this.baseUrl}/api/${path.replace(/^\/+/, "")}`, {
      ...init,
      headers,
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw toPbError(response.status, body, operation);
    return body as T;
  }

  list<T extends PocketBaseRecord>(
    collection: string,
    args: { filter?: string; sort?: string; perPage?: number; expand?: string } = {},
  ): Promise<PocketBaseList<T>> {
    const params = new URLSearchParams();
    params.set("perPage", String(args.perPage ?? 100));
    if (args.filter) params.set("filter", args.filter);
    if (args.sort) params.set("sort", args.sort);
    if (args.expand) params.set("expand", args.expand);
    return this.request<PocketBaseList<T>>(
      `collections/${collection}/records?${params.toString()}`,
      {},
      `pocketbase.${collection}.list`,
    );
  }

  get<T extends PocketBaseRecord>(collection: string, id: string): Promise<T> {
    return this.request<T>(`collections/${collection}/records/${id}`, {}, `pocketbase.${collection}.get`);
  }

  create<T extends PocketBaseRecord>(collection: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(
      `collections/${collection}/records`,
      { method: "POST", body: JSON.stringify(body) },
      `pocketbase.${collection}.create`,
    );
  }

  update<T extends PocketBaseRecord>(collection: string, id: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(
      `collections/${collection}/records/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
      `pocketbase.${collection}.update`,
    );
  }

  delete(collection: string, id: string): Promise<void> {
    return this.request<void>(
      `collections/${collection}/records/${id}`,
      { method: "DELETE" },
      `pocketbase.${collection}.delete`,
    );
  }
}

export function createPocketBaseBackend(config: ServerConfig): TeamClawBackend {
  const baseUrl = normalizeUrl(config.pocketbaseUrl);
  const pb = new PocketBaseRestClient(baseUrl);
  const listeners = new Set<(session: AuthSession | null) => void>();

  function emitAuth(session: AuthSession | null): void {
    listeners.forEach((listener) => listener(session));
  }

  async function currentSessionRequired(): Promise<AuthSession> {
    const session = sessionFromAuth(getStoredAuth());
    if (!session) {
      throw new BackendError({
        category: "Unauthenticated",
        operation: "pocketbase.auth.session",
        message: "PocketBase session missing. Use Quick trial to sign in.",
      });
    }
    return session;
  }

  async function currentMemberActor(teamId?: string): Promise<ActorDirectoryEntry | null> {
    const session = await currentSessionRequired();
    const filters = [`account = ${quoteFilter(session.user.id)}`, `actor_type = "member"`];
    if (teamId) filters.push(`team = ${quoteFilter(teamId)}`);
    const { items } = await pb.list<PocketBaseRecord>("actors", {
      filter: filters.join(" && "),
      perPage: 1,
    });
    return items[0] ? mapActor(items[0]) : null;
  }

  async function currentTeamId(): Promise<string | null> {
    const actor = await currentMemberActor();
    return actor?.team_id ?? null;
  }

  return {
    kind: "pocketbase",
    auth: {
      async getSession() {
        return sessionFromAuth(getStoredAuth());
      },
      onAuthStateChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async sendOtp() {
        throw new BackendError({
          category: "Unsupported",
          operation: "pocketbase.auth.sendOtp",
          message: "PocketBase preview uses Quick trial seeded credentials instead of OTP.",
        });
      },
      async verifyOtp() {
        throw new BackendError({
          category: "Unsupported",
          operation: "pocketbase.auth.verifyOtp",
          message: "PocketBase preview uses Quick trial seeded credentials instead of OTP.",
        });
      },
      async signInAnonymously() {
        const email = import.meta.env.VITE_POCKETBASE_PREVIEW_EMAIL || DEFAULT_PREVIEW_EMAIL;
        const password = import.meta.env.VITE_POCKETBASE_PREVIEW_PASSWORD || DEFAULT_PREVIEW_PASSWORD;
        const auth = await pb.request<StoredAuth>(
          "collections/accounts/auth-with-password",
          {
            method: "POST",
            body: JSON.stringify({ identity: email, password }),
          },
          "pocketbase.auth.signInPreview",
        );
        saveStoredAuth(auth);
        const session = sessionFromAuth(auth);
        emitAuth(session);
        return session;
      },
      async signOut() {
        saveStoredAuth(null);
        emitAuth(null);
      },
      async claimInvite() {
        throw new BackendError({
          category: "Unsupported",
          operation: "pocketbase.auth.claimInvite",
          message: "PocketBase invite claim custom route is not wired in this preview.",
        });
      },
    },
    directory: {
      async resolveCurrentMemberActor(teamId) {
        return currentMemberActor(teamId);
      },
      async resolveFirstMemberActorForUser(userId) {
        const { items } = await pb.list<PocketBaseRecord>("actors", {
          filter: `account = ${quoteFilter(userId)} && actor_type = "member"`,
          perPage: 1,
        });
        return items[0] ? mapActor(items[0]) : null;
      },
      async getCurrentTeamMember(teamId, userId) {
        const actor = await this.resolveFirstMemberActorForUser(userId);
        if (!actor) return null;
        const { items } = await pb.list<PocketBaseRecord>("team_members", {
          filter: `team = ${quoteFilter(teamId)} && actor = ${quoteFilter(actor.id)}`,
          perPage: 1,
        });
        const member = items[0];
        if (!member) return null;
        return {
          id: actor.id,
          displayName: "Preview User",
          role: typeof member.role === "string" ? member.role : null,
          joinedAt: typeof member.joined_at === "string" ? member.joined_at : null,
        };
      },
    },
    sessions: {
      async listCurrentActorSessions({ limit }) {
        const teamId = await currentTeamId();
        if (!teamId) return { rows: [] };
        const { items } = await pb.list<PocketBaseRecord>("sessions", {
          filter: `team = ${quoteFilter(teamId)}`,
          sort: "-last_message_at,-created",
          perPage: limit,
        });
        return { rows: items.map(mapSession) };
      },
      async markCurrentActorSessionViewed() {},
      async createSessionShell(input) {
        const row = await pb.create<PocketBaseRecord>("sessions", {
          id: input.id,
          team: input.teamId,
          title: input.title,
          mode: "collab",
          created_by_actor: input.createdByActorId,
          primary_agent: input.additionalActorIds[0] ?? "",
          idea_id: input.ideaId ?? "",
          last_message_at: nowIso(),
        });
        const actors = [input.createdByActorId, ...input.additionalActorIds].filter(Boolean);
        await Promise.all(actors.map((actorId, index) => pb.create("session_participants", {
          team: input.teamId,
          session: row.id,
          actor: actorId,
          role: index === 0 ? "owner" : "agent",
          joined_at: nowIso(),
        }).catch((error) => {
          const backendError = toBackendError(error, "pocketbase.sessionParticipants.create");
          if (backendError.status !== 400) throw backendError;
        })));
        return { sessionId: row.id };
      },
      async addParticipants(sessionId, actorIds) {
        const teamId = await this.getSessionTeamId(sessionId);
        if (!teamId) return;
        await Promise.all(actorIds.map((actorId) => pb.create("session_participants", {
          team: teamId,
          session: sessionId,
          actor: actorId,
          role: "agent",
          joined_at: nowIso(),
        }).catch(() => undefined)));
      },
      async updateSessionTitle(sessionId, title) {
        await pb.update("sessions", sessionId, { title });
      },
      async archiveSession(sessionId, archivedAt) {
        await pb.update("sessions", sessionId, { archived_at: archivedAt });
      },
      async getSessionParticipants(sessionId) {
        const { items } = await pb.list<PocketBaseRecord>("session_participants", {
          filter: `session = ${quoteFilter(sessionId)}`,
        });
        return items.map((row): SessionParticipant => ({
          session_id: relationId(row.session) ?? sessionId,
          actor_id: relationId(row.actor) ?? "",
          role: typeof row.role === "string" ? row.role : null,
        })).filter((row) => row.actor_id);
      },
      async getSessionTeamId(sessionId) {
        try {
          const row = await pb.get<PocketBaseRecord>("sessions", sessionId);
          return relationId(row.team);
        } catch (error) {
          const backendError = toBackendError(error, "pocketbase.sessions.getSessionTeamId");
          if (backendError.category === "NotFound") return null;
          throw backendError;
        }
      },
      async listSessionsForTeamSince(teamId, updatedAfter) {
        const { items } = await pb.list<PocketBaseRecord>("sessions", {
          filter: `team = ${quoteFilter(teamId)}`,
          sort: "updated",
        });
        return items
          .filter((row) => rowDate(row, "updated") > updatedAfter)
          .map((row): SessionSyncRow => ({
            id: row.id,
            team_id: relationId(row.team) ?? teamId,
            title: typeof row.title === "string" ? row.title : null,
            mode: typeof row.mode === "string" ? row.mode : null,
            primary_agent_id: relationId(row.primary_agent),
            idea_id: typeof row.idea_id === "string" ? row.idea_id : null,
            summary: typeof row.summary === "string" ? row.summary : null,
            last_message_preview: typeof row.last_message_preview === "string" ? row.last_message_preview : null,
            last_message_at: typeof row.last_message_at === "string" ? row.last_message_at : null,
            created_by_actor_id: relationId(row.created_by_actor),
            created_at: rowDate(row, "created"),
            updated_at: rowDate(row, "updated"),
          }));
      },
      async listSessionDisplayRows(_teamId, sessionIds) {
        const rows = await Promise.all(sessionIds.map(async (id): Promise<SessionDisplayRow | null> => {
          try {
            const row = await pb.get<PocketBaseRecord>("sessions", id);
            return { id: row.id, title: typeof row.title === "string" ? row.title : null };
          } catch {
            return null;
          }
        }));
        return rows.filter((row): row is SessionDisplayRow => Boolean(row));
      },
    },
    messages: {
      async insertOutgoingMessage(input) {
        const row = await pb.create<PocketBaseRecord>("messages", {
          id: input.id,
          team: input.teamId,
          session: input.sessionId,
          sender_actor: input.senderActorId,
          kind: input.kind ?? "text",
          content: input.content,
          metadata: input.metadata ?? {},
          model: input.model ?? "",
          turn_id: input.turnId ?? "",
          reply_to_message_id: input.replyToMessageId ?? "",
          attachments: input.attachments ?? [],
          sequence: Date.now(),
        });
        await pb.update("sessions", input.sessionId, {
          last_message_preview: input.content.slice(0, 240),
          last_message_at: rowDate(row, "created"),
        }).catch(() => undefined);
        return mapMessage(row);
      },
      async listMessages(sessionId) {
        const { items } = await pb.list<PocketBaseRecord>("messages", {
          filter: `session = ${quoteFilter(sessionId)}`,
          sort: "created",
        });
        return items.map(mapMessage);
      },
      async updateMessageContent(messageId, content) {
        await pb.update("messages", messageId, { content });
      },
      async listMessagesForSessionSince(sessionId, updatedAfter) {
        const rows = await this.listMessages(sessionId);
        return rows
          .filter((row) => !updatedAfter || (row.updated_at ?? row.created_at) > updatedAfter)
          .map((row): MessageSyncRow => ({ ...row, updated_at: row.updated_at ?? row.created_at }));
      },
    },
    runtime: {
      async listLatestAgentRuntimeHints(teamId, agentActorIds) {
        if (agentActorIds.length === 0) return [];
        const { items } = await pb.list<PocketBaseRecord>("agent_runtimes", {
          filter: `team = ${quoteFilter(teamId)}`,
          sort: "-updated",
        });
        return items
          .filter((row) => agentActorIds.includes(relationId(row.agent) ?? ""))
          .map((row) => ({
            id: row.id,
            agent_id: relationId(row.agent) ?? "",
            workspace_id: relationId(row.workspace),
            backend_type: typeof row.backend_type === "string" ? row.backend_type : null,
            runtime_id: typeof row.runtime_id === "string" ? row.runtime_id : null,
            session_id: relationId(row.session),
            status: typeof row.status === "string" ? row.status : null,
            current_model: typeof row.current_model === "string" ? row.current_model : null,
            updated_at: rowDate(row, "updated"),
          }));
      },
      async listAgentDefaults(agentActorIds) {
        const rows = await Promise.all(agentActorIds.map((id) => pb.get<PocketBaseRecord>("actors", id).catch(() => null)));
        return rows.filter((row): row is PocketBaseRecord => Boolean(row)).map((row) => ({
          id: row.id,
          agent_types: Array.isArray(row.agent_types) ? row.agent_types.filter((v): v is string => typeof v === "string") : null,
          default_agent_type: typeof row.default_agent_type === "string" ? row.default_agent_type : null,
        }));
      },
      async updateRuntimeModel() {},
      async listSessionRuntimeModels(sessionId) {
        const { items } = await pb.list<PocketBaseRecord>("agent_runtimes", {
          filter: `session = ${quoteFilter(sessionId)}`,
        });
        return items.map((row) => ({
          runtime_id: typeof row.runtime_id === "string" ? row.runtime_id : null,
          backend_type: typeof row.backend_type === "string" ? row.backend_type : null,
          current_model: typeof row.current_model === "string" ? row.current_model : null,
        }));
      },
      async listRuntimeTargetsForSession(sessionId, agentActorIds) {
        const { items } = await pb.list<PocketBaseRecord>("agent_runtimes", {
          filter: `session = ${quoteFilter(sessionId)}`,
        });
        return items
          .filter((row) => agentActorIds.includes(relationId(row.agent) ?? ""))
          .map((row) => ({
            agent_id: relationId(row.agent),
            runtime_id: typeof row.runtime_id === "string" ? row.runtime_id : null,
          }));
      },
      async listDaemonRuntimes(teamId) {
        const { items } = await pb.list<PocketBaseRecord>("agent_runtimes", {
          filter: `team = ${quoteFilter(teamId)}`,
        });
        return items.map((row) => ({
          id: row.id,
          runtime_id: typeof row.runtime_id === "string" ? row.runtime_id : null,
          team_id: relationId(row.team) ?? teamId,
          agent_id: relationId(row.agent) ?? "",
          session_id: relationId(row.session),
          workspace_id: relationId(row.workspace),
          backend_type: typeof row.backend_type === "string" ? row.backend_type : "",
          backend_session_id: typeof row.backend_session_id === "string" ? row.backend_session_id : null,
          status: typeof row.status === "string" ? row.status : "",
          current_model: typeof row.current_model === "string" ? row.current_model : null,
          last_seen_at: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
          created_at: rowDate(row, "created"),
          updated_at: rowDate(row, "updated"),
        }));
      },
    },
    attachments: createUnsupportedPocketBaseService("attachments"),
    teams: {
      async listCurrentUserTeams(args) {
        const actor = await currentMemberActor();
        if (!actor?.team_id) return [];
        const team = await pb.get<PocketBaseRecord>("teams", actor.team_id);
        const rows = [mapTeam(team)];
        return typeof args?.limit === "number" ? rows.slice(0, args.limit) : rows;
      },
      async getTeam(teamId) {
        try {
          return mapTeam(await pb.get<PocketBaseRecord>("teams", teamId));
        } catch (error) {
          const backendError = toBackendError(error, "pocketbase.teams.getTeam");
          if (backendError.category === "NotFound") return null;
          throw backendError;
        }
      },
      async createTeam(input) {
        const session = await currentSessionRequired();
        const team = await pb.create<PocketBaseRecord>("teams", {
          name: input.name,
          slug: input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        });
        const actor = await pb.create<PocketBaseRecord>("actors", {
          team: team.id,
          account: session.user.id,
          actor_type: "member",
          display_name: typeof session.user.display_name === "string" ? session.user.display_name : "Preview User",
          last_active_at: nowIso(),
        });
        await pb.create("team_members", {
          team: team.id,
          actor: actor.id,
          role: "owner",
          status: "active",
          joined_at: nowIso(),
        });
        return mapTeam(team);
      },
      async renameTeam(teamId, name) {
        return mapTeam(await pb.update<PocketBaseRecord>("teams", teamId, { name }));
      },
      async createTeamInvite() {
        return { token: "pocketbase-preview-invites-not-wired" };
      },
      async removeTeamActor() {},
    },
    ideas: {
      async listIdeas(teamId) {
        const { items } = await pb.list<PocketBaseRecord>("ideas", {
          filter: `team = ${quoteFilter(teamId)}`,
          sort: "sort_order,-updated",
        });
        return items.map((row) => ({
          id: row.id,
          team_id: relationId(row.team) ?? teamId,
          title: typeof row.title === "string" ? row.title : "Untitled",
          description: typeof row.description === "string" ? row.description : null,
          status: typeof row.status === "string" ? row.status : null,
          created_by_actor_id: relationId(row.created_by_actor),
          created_at: rowDate(row, "created"),
          updated_at: rowDate(row, "updated"),
          archived: Boolean(row.archived),
          sort_order: typeof row.sort_order === "number" ? row.sort_order : null,
        }));
      },
      async getIdeaDetail() { return null; },
      async createIdea(input) {
        const actor = await currentMemberActor(input.teamId);
        const row = await pb.create<PocketBaseRecord>("ideas", {
          team: input.teamId,
          title: input.title,
          description: input.body ?? "",
          status: "open",
          created_by_actor: actor?.id ?? "",
          archived: false,
        });
        return {
          id: row.id,
          team_id: relationId(row.team) ?? input.teamId,
          title: typeof row.title === "string" ? row.title : input.title,
          description: typeof row.description === "string" ? row.description : null,
          status: typeof row.status === "string" ? row.status : null,
          created_by_actor_id: relationId(row.created_by_actor),
          created_at: rowDate(row, "created"),
          updated_at: rowDate(row, "updated"),
          archived: Boolean(row.archived),
        };
      },
      async updateIdea(input) {
        const patch: Record<string, unknown> = {};
        if ("title" in input && input.title !== undefined) patch.title = input.title;
        if ("description" in input && input.description !== undefined) patch.description = input.description ?? "";
        if ("status" in input && input.status !== undefined) patch.status = input.status ?? "open";
        if ("sortOrder" in input && input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
        await pb.update("ideas", input.ideaId, patch);
      },
      async archiveIdea(ideaId) {
        await pb.update("ideas", ideaId, { archived: true });
      },
      async createIdeaActivity() {},
    },
    actors: {
      async listActorDirectory(teamId) {
        const { items } = await pb.list<PocketBaseRecord>("actors", {
          filter: `team = ${quoteFilter(teamId)}`,
          sort: "actor_type,display_name",
        });
        return items.map(mapActor);
      },
      async listActorDirectoryByIds(actorIds) {
        const rows = await Promise.all(actorIds.map((id) => pb.get<PocketBaseRecord>("actors", id).catch(() => null)));
        return rows.filter((row): row is PocketBaseRecord => Boolean(row)).map(mapActor);
      },
      async getActorDirectoryEntry(actorId) {
        try {
          return mapActor(await pb.get<PocketBaseRecord>("actors", actorId));
        } catch (error) {
          const backendError = toBackendError(error, "pocketbase.actors.getActorDirectoryEntry");
          if (backendError.category === "NotFound") return null;
          throw backendError;
        }
      },
      async getDaemonAgentDirectoryEntry(teamId, agentId) {
        const row = await this.getActorDirectoryEntry(agentId);
        return row?.team_id === teamId ? row : null;
      },
      async listConnectedAgents(teamId) {
        const rows = await this.listActorDirectory(teamId);
        return rows
          .filter((row) => row.actor_type === "agent")
          .map((row) => ({ ...row, agent_id: row.id, permission_level: "admin", visibility: "team", is_owner: true }));
      },
      async updateOwnedAgentProfile(input) {
        await pb.update("actors", input.agentId, {
          ...(input.displayName !== undefined ? { display_name: input.displayName ?? "" } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility ?? "" } : {}),
        });
      },
      async updateAgentDefaults(input) {
        await pb.update("actors", input.agentId, {
          ...(input.agentTypes !== undefined ? { agent_types: input.agentTypes ?? [] } : {}),
          ...(input.defaultAgentType !== undefined ? { default_agent_type: input.defaultAgentType ?? "" } : {}),
          ...(input.defaultWorkspaceId !== undefined ? { default_workspace_id: input.defaultWorkspaceId ?? "" } : {}),
        });
      },
      async listAgentAccess() { return []; },
      async listTeamMembersForAccess(teamId) {
        return (await this.listActorDirectory(teamId))
          .filter((row) => row.actor_type === "member")
          .map((row) => ({ id: row.id, displayName: row.display_name ?? "Member", role: row.team_role ?? null }));
      },
      async upsertAgentAccess() {},
      async removeAgentAccess() {},
    },
    sessionMembers: {
      async listParticipants(sessionId) {
        const { items } = await pb.list<PocketBaseRecord>("session_participants", {
          filter: `session = ${quoteFilter(sessionId)}`,
          expand: "actor",
        });
        return items
          .map((row) => {
            const expanded = row.expand?.actor;
            return expanded && typeof expanded === "object" ? mapActor(expanded as PocketBaseRecord) : null;
          })
          .filter((row): row is ActorDirectoryEntry => Boolean(row));
      },
      async listSessionIdsForActor(actorId) {
        const { items } = await pb.list<PocketBaseRecord>("session_participants", {
          filter: `actor = ${quoteFilter(actorId)}`,
        });
        return items.map((row) => relationId(row.session)).filter((id): id is string => Boolean(id));
      },
      async listCandidateActors(teamId, presentActorIds) {
        const { items } = await pb.list<PocketBaseRecord>("actors", {
          filter: `team = ${quoteFilter(teamId)}`,
        });
        return items.map((row): SessionMemberCandidate => ({
          ...mapActor(row),
          is_present: presentActorIds.includes(row.id),
        }));
      },
      async addParticipant(sessionId, actorId) {
        const session = await pb.get<PocketBaseRecord>("sessions", sessionId);
        await pb.create("session_participants", {
          team: relationId(session.team) ?? "",
          session: sessionId,
          actor: actorId,
          role: "agent",
          joined_at: nowIso(),
        }).catch(() => undefined);
      },
      async removeParticipant(sessionId, actorId) {
        const { items } = await pb.list<PocketBaseRecord>("session_participants", {
          filter: `session = ${quoteFilter(sessionId)} && actor = ${quoteFilter(actorId)}`,
          perPage: 1,
        });
        if (items[0]) await pb.delete("session_participants", items[0].id);
      },
    },
    shortcuts: {
      async listShortcuts() { return []; },
      async createShortcut() { return { id: crypto.randomUUID() }; },
      async updateShortcut() {},
      async deleteShortcut() {},
      async batchMove() { return null; },
      async setVisibleRoles() {},
      async listTeamRoles(teamId) { return [{ id: "owner", team_id: teamId, code: "owner", name: "Owner" }]; },
      async listShortcutRoleBindings() { return []; },
    },
    notifications: {
      async loadPreferences() { return null; },
      async savePreferences() {},
      async setSessionMuted() {},
      async listMutedSessionIds() { return []; },
    },
    teamWorkspaceConfig: {
      async load(teamId) {
        const { items } = await pb.list<PocketBaseRecord>("team_workspace_config", {
          filter: `team = ${quoteFilter(teamId)}`,
          perPage: 1,
        });
        const row = items[0];
        if (!row) return null;
        return {
          team_id: relationId(row.team) ?? teamId,
          workspace_path: typeof row.workspace_path === "string" ? row.workspace_path : null,
          git_url: typeof row.git_url === "string" ? row.git_url : null,
          git_branch: typeof row.git_branch === "string" ? row.git_branch : null,
          git_token: typeof row.git_token === "string" ? row.git_token : null,
          ai_gateway_endpoint: typeof row.ai_gateway_endpoint === "string" ? row.ai_gateway_endpoint : null,
          enabled: Boolean(row.enabled),
          updated_at: rowDate(row, "updated"),
          metadata: row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : null,
        };
      },
      async save(input) {
        const { items } = await pb.list<PocketBaseRecord>("team_workspace_config", {
          filter: `team = ${quoteFilter(input.team_id)}`,
          perPage: 1,
        });
        const patch = {
          team: input.team_id,
          workspace_path: input.workspace_path ?? "",
          git_url: input.git_url ?? "",
          git_branch: input.git_branch ?? "",
          git_token: input.git_token ?? "",
          ai_gateway_endpoint: input.ai_gateway_endpoint ?? "",
          enabled: input.enabled ?? true,
          metadata: input.metadata ?? {},
        };
        if (items[0]) await pb.update("team_workspace_config", items[0].id, patch);
        else await pb.create("team_workspace_config", patch);
      },
    },
    workspaces: {
      async listWorkspacesByIds(_teamId, workspaceIds) {
        const rows = await Promise.all(workspaceIds.map((id) => pb.get<PocketBaseRecord>("workspaces", id).catch(() => null)));
        return rows.filter((row): row is PocketBaseRecord => Boolean(row)).map((row) => ({
          id: row.id,
          name: typeof row.name === "string" ? row.name : null,
          path: typeof row.path === "string" ? row.path : null,
        }));
      },
      async listDaemonWorkspaces(teamId, agentId) {
        const filters = [`team = ${quoteFilter(teamId)}`];
        if (agentId) filters.push(`agent = ${quoteFilter(agentId)}`);
        const { items } = await pb.list<PocketBaseRecord>("workspaces", {
          filter: filters.join(" && "),
        });
        return items.map((row) => ({
          id: row.id,
          team_id: relationId(row.team) ?? teamId,
          agent_id: relationId(row.agent),
          created_by_member_id: null,
          name: typeof row.name === "string" ? row.name : "Workspace",
          path: typeof row.path === "string" ? row.path : null,
          archived: Boolean(row.archived_at),
          created_at: rowDate(row, "created"),
          updated_at: rowDate(row, "updated"),
        }));
      },
      async createDaemonWorkspace(input) {
        const row = await pb.create<PocketBaseRecord>("workspaces", {
          team: input.teamId,
          agent: input.agentId,
          name: input.name,
          path: input.path,
          metadata: {},
        });
        return {
          id: row.id,
          team_id: relationId(row.team) ?? input.teamId,
          agent_id: relationId(row.agent),
          created_by_member_id: input.createdByMemberId,
          name: typeof row.name === "string" ? row.name : input.name,
          path: typeof row.path === "string" ? row.path : input.path,
          archived: false,
          created_at: rowDate(row, "created"),
          updated_at: rowDate(row, "updated"),
        };
      },
      async updateDaemonWorkspace(input) {
        const row = await pb.update<PocketBaseRecord>("workspaces", input.workspaceId, {
          name: input.name,
          path: input.path,
          archived_at: input.archived ? nowIso() : "",
        });
        return {
          id: row.id,
          team_id: relationId(row.team) ?? "",
          agent_id: relationId(row.agent),
          created_by_member_id: null,
          name: typeof row.name === "string" ? row.name : input.name,
          path: typeof row.path === "string" ? row.path : input.path,
          archived: Boolean(row.archived_at),
          created_at: rowDate(row, "created"),
          updated_at: rowDate(row, "updated"),
        };
      },
    },
    sync: {
      async listActorDirectoryForSync(teamId, updatedAfter) {
        const { items } = await pb.list<PocketBaseRecord>("actors", {
          filter: `team = ${quoteFilter(teamId)}`,
          sort: "updated",
        });
        return items
          .filter((row) => !updatedAfter || rowDate(row, "updated") > updatedAfter)
          .map((row): ActorDirectorySyncRow => ({
            id: row.id,
            team_id: relationId(row.team) ?? teamId,
            actor_type: typeof row.actor_type === "string" ? row.actor_type : "member",
            display_name: typeof row.display_name === "string" ? row.display_name : "",
            member_status: null,
            agent_status: typeof row.device_id === "string" && row.device_id ? "online" : null,
            last_active_at: typeof row.last_active_at === "string" ? row.last_active_at : null,
            created_at: rowDate(row, "created"),
            updated_at: rowDate(row, "updated"),
          }));
      },
      async listIdeasForSync(teamId, updatedAfter) {
        const { items } = await pb.list<PocketBaseRecord>("ideas", {
          filter: `team = ${quoteFilter(teamId)}`,
          sort: "updated",
        });
        return items
          .filter((row) => !updatedAfter || rowDate(row, "updated") > updatedAfter)
          .map((row): IdeaSyncRow => ({
            id: row.id,
            team_id: relationId(row.team) ?? teamId,
            workspace_id: relationId(row.workspace),
            parent_idea_id: typeof row.parent_idea_id === "string" ? row.parent_idea_id : null,
            title: typeof row.title === "string" ? row.title : "Untitled",
            description: typeof row.description === "string" ? row.description : null,
            status: typeof row.status === "string" ? row.status : null,
            created_by_actor_id: relationId(row.created_by_actor),
            archived: Boolean(row.archived),
            sort_order: typeof row.sort_order === "number" ? row.sort_order : null,
            created_at: rowDate(row, "created"),
            updated_at: rowDate(row, "updated"),
          }));
      },
      async listSessionParticipantsForSync(sessionId) {
        const { items } = await pb.list<PocketBaseRecord>("session_participants", {
          filter: `session = ${quoteFilter(sessionId)}`,
        });
        return items.map((row) => ({
          id: row.id,
          session_id: relationId(row.session) ?? sessionId,
          actor_id: relationId(row.actor) ?? "",
          role: typeof row.role === "string" ? row.role : null,
          joined_at: typeof row.joined_at === "string" ? row.joined_at : null,
          created_at: rowDate(row, "created"),
          updated_at: rowDate(row, "updated"),
        }));
      },
    },
    telemetry: createUnsupportedPocketBaseService("telemetry"),
  };
}
