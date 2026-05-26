export type BackendKind = "supabase" | "pocketbase" | "local";

export interface AuthUser {
  id: string;
  email?: string | null;
  [key: string]: unknown;
}

export interface AuthSession {
  user: AuthUser;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  providerData?: unknown;
}

export interface AuthClaimResult {
  actorId: string;
  teamId: string;
  actorType: string;
  displayName: string;
  refreshToken: string | null;
}

export type Unsubscribe = () => void;

export interface AuthBackend {
  getSession(): Promise<AuthSession | null>;
  onAuthStateChange(listener: (session: AuthSession | null) => void): Unsubscribe;
  sendOtp(email: string): Promise<void>;
  verifyOtp(email: string, code: string): Promise<AuthSession | null>;
  signInAnonymously(): Promise<AuthSession | null>;
  signOut(): Promise<void>;
  claimInvite(token: string): Promise<AuthClaimResult>;
}

export interface SessionListEntry {
  id: string;
  title: string;
  team_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  mode: "solo" | "collab" | "control";
  idea_id: string | null;
  has_unread: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface SessionSyncRow {
  id: string;
  team_id: string;
  title?: string | null;
  mode?: string | null;
  primary_agent_id?: string | null;
  idea_id?: string | null;
  summary?: string | null;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  created_by_actor_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionListCursor {
  lastMessageAt: string | null;
  createdAt: string | null;
  id: string;
}

export interface SessionListPage {
  rows: SessionListEntry[];
}

export interface SessionCreateInput {
  id: string;
  teamId: string;
  createdByActorId: string;
  title: string;
  additionalActorIds: string[];
  ideaId?: string | null;
}

export interface SessionParticipant {
  session_id: string;
  actor_id: string;
  role?: string | null;
}

export interface SessionsBackend {
  listCurrentActorSessions(args: { limit: number; cursor: SessionListCursor | null }): Promise<SessionListPage>;
  markCurrentActorSessionViewed(sessionId: string, lastReadMessageId?: string | null): Promise<void>;
  createSessionShell(input: SessionCreateInput): Promise<{ sessionId: string }>;
  addParticipants(sessionId: string, actorIds: string[]): Promise<void>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
  archiveSession(sessionId: string, archivedAt: string): Promise<void>;
  getSessionParticipants(sessionId: string): Promise<SessionParticipant[]>;
  getSessionTeamId(sessionId: string): Promise<string | null>;
  listSessionsForTeamSince(teamId: string, updatedAfter: string): Promise<SessionSyncRow[]>;
}

export interface OutgoingMessageInput {
  id?: string;
  teamId: string;
  sessionId: string;
  senderActorId: string;
  content: string;
  kind?: string;
  metadata?: Record<string, unknown> | null;
  turnId?: string | null;
  replyToMessageId?: string | null;
  attachments?: AttachmentRef[];
  createdAt?: string;
  model?: string | null;
  mentionActorIds?: string[];
}

export interface MessageHistoryRow {
  id: string;
  team_id: string;
  session_id: string;
  turn_id: string | null;
  sender_actor_id: string | null;
  reply_to_message_id: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  model?: string | null;
  mentions?: string[] | null;
  parts?: unknown[] | null;
  attachments?: AttachmentRef[] | null;
  created_at: string;
  updated_at: string | null;
}

export interface MessageSyncRow {
  id: string;
  team_id: string;
  session_id: string;
  turn_id?: string | null;
  sender_actor_id?: string | null;
  reply_to_message_id?: string | null;
  kind: string;
  content: string;
  metadata?: unknown | null;
  model?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessagesBackend {
  insertOutgoingMessage(input: OutgoingMessageInput): Promise<MessageHistoryRow>;
  listMessages(sessionId: string): Promise<MessageHistoryRow[]>;
  updateMessageContent(messageId: string, content: string): Promise<void>;
  listMessagesForSessionSince(sessionId: string, updatedAfter?: string | null): Promise<MessageSyncRow[]>;
}

export interface AgentRuntimeHintRow {
  id: string;
  agent_id: string;
  workspace_id: string | null;
  backend_type: string | null;
  runtime_id: string | null;
  session_id: string | null;
  status: string | null;
  current_model: string | null;
  updated_at: string | null;
}

export interface AgentDefaultRow {
  id: string;
  agent_types: string[] | null;
  default_agent_type: string | null;
}

export interface RuntimeBackend {
  listLatestAgentRuntimeHints(teamId: string, agentActorIds: string[]): Promise<AgentRuntimeHintRow[]>;
  listAgentDefaults(agentActorIds: string[]): Promise<AgentDefaultRow[]>;
  updateRuntimeModel(runtimeId: string, model: string): Promise<void>;
}

export interface AttachmentUploadInput {
  file: File;
  teamId: string;
  sessionId: string;
}

export interface AttachmentRef {
  attachmentId: string;
  fileName: string;
  signedUrl: string;
  mimeType: string;
  size: number;
}

export interface AttachmentsBackend {
  uploadAttachment(input: AttachmentUploadInput): Promise<AttachmentRef>;
}

export interface DirectoryMemberActor {
  id: string;
  team_id?: string;
}

export interface DirectoryBackend {
  resolveCurrentMemberActor(teamId: string, userId: string): Promise<DirectoryMemberActor | null>;
  resolveFirstMemberActorForUser(userId: string): Promise<DirectoryMemberActor | null>;
}

export interface TeamSummary {
  id: string;
  name: string;
  slug?: string | null;
  created_at?: string | null;
}

export interface TeamInviteResult {
  token: string;
  inviteUrl?: string | null;
  deeplink?: string | null;
  expiresAt?: string | null;
  actorId?: string | null;
}

type TeamInviteBaseInput = {
  teamId: string;
  displayName?: string | null;
  ttlSeconds?: number | null;
  targetActorId?: string | null;
};

export type TeamInviteInput =
  | (TeamInviteBaseInput & {
      kind: "member";
      actorType?: "member";
      teamRole: "owner" | "admin" | "member";
      agentKind?: null;
    })
  | (TeamInviteBaseInput & {
      actorType: "member";
      kind?: "member";
      teamRole: "owner" | "admin" | "member";
      agentKind?: null;
    })
  | (TeamInviteBaseInput & {
      kind: "agent";
      actorType?: "agent";
      agentKind: string;
      teamRole?: null;
    })
  | (TeamInviteBaseInput & {
      actorType: "agent";
      kind?: "agent";
      agentKind: string;
      teamRole?: null;
    });

export interface TeamsBackend {
  createTeam(input: { name: string; slug?: string | null }): Promise<TeamSummary>;
  renameTeam(teamId: string, name: string): Promise<TeamSummary>;
  createTeamInvite(input: TeamInviteInput): Promise<TeamInviteResult>;
  removeTeamActor(actorId: string): Promise<void>;
}

export interface IdeaRow {
  id: string;
  team_id: string;
  title: string;
  body?: string | null;
  description?: string | null;
  workspace_id?: string | null;
  status?: string | null;
  created_by_actor_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  archived_at?: string | null;
  archived?: boolean | null;
  sort_order?: number | null;
}

export interface IdeaActivityRow {
  id: string;
  actor_id: string;
  activity_type: string;
  content?: string | null;
  created_at: string;
}

export interface IdeaActorSummary {
  id: string;
  display_name: string | null;
  actor_type?: string | null;
}

export interface IdeaDetailRow extends IdeaRow {
  description?: string | null;
  workspace_id?: string | null;
  activities?: IdeaActivityRow[];
  actors?: IdeaActorSummary[];
}

export type IdeaSortOrderUpdateInput = {
  ideaId: string;
  sortOrder: number | null;
  title?: never;
  body?: never;
  description?: never;
  status?: never;
  workspaceId?: never;
};

export type IdeaFullUpdateInput = {
  ideaId: string;
  title: string;
  body?: string | null;
  description?: string | null;
  status: string | null;
  workspaceId: string | null;
  sortOrder?: never;
};

export interface IdeasBackend {
  listIdeas(teamId: string): Promise<IdeaRow[]>;
  getIdeaDetail(ideaId: string): Promise<IdeaDetailRow | null>;
  createIdea(input: { teamId: string; title: string; body?: string | null; workspaceId?: string | null }): Promise<IdeaRow>;
  updateIdea(input: IdeaSortOrderUpdateInput | IdeaFullUpdateInput): Promise<void>;
  archiveIdea(ideaId: string): Promise<void>;
  createIdeaActivity(input: {
    ideaId: string;
    actorId?: string | null;
    eventType?: string;
    activityType?: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void>;
}

export interface ActorDirectoryEntry {
  id: string;
  team_id: string;
  display_name: string | null;
  actor_type: string | null;
  avatar_url?: string | null;
  user_id?: string | null;
  last_active_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  member_status?: string | null;
  agent_status?: string | null;
  team_role?: string | null;
  agent_types?: string[] | null;
  default_agent_type?: string | null;
  default_workspace_id?: string | null;
}

export interface ConnectedAgentRow extends ActorDirectoryEntry {
  agent_id?: string | null;
  device_id?: string | null;
  agent_types?: string[] | null;
  default_agent_type?: string | null;
  permission_level?: string | null;
  visibility?: string | null;
  is_owner?: boolean | null;
}

export interface ActorsBackend {
  listActorDirectory(teamId: string): Promise<ActorDirectoryEntry[]>;
  listConnectedAgents(teamId: string): Promise<ConnectedAgentRow[]>;
  updateOwnedAgentProfile(input: {
    agentId: string;
    displayName?: string | null;
    visibility?: string | null;
  }): Promise<void>;
  updateAgentDefaults(input: {
    agentId: string;
    agentTypes?: string[] | null;
    agentKind?: string | null;
    defaultAgentType?: string | null;
    defaultWorkspaceId?: string | null;
  }): Promise<void>;
}

export interface SessionMemberCandidate extends ActorDirectoryEntry {
  is_present: boolean;
}

export interface SessionMembersBackend {
  listParticipants(sessionId: string): Promise<ActorDirectoryEntry[]>;
  listSessionIdsForActor(actorId: string): Promise<string[]>;
  listCandidateActors(teamId: string, presentActorIds: string[]): Promise<SessionMemberCandidate[]>;
  addParticipant(sessionId: string, actorId: string): Promise<void>;
  removeParticipant(sessionId: string, actorId: string): Promise<void>;
}

export interface ShortcutRow {
  id: string;
  scope: string;
  title: string;
  payload: unknown;
  sort_order?: number | null;
  visible_roles?: string[] | null;
}

export interface ShortcutsBackend {
  listShortcuts(scope: string): Promise<ShortcutRow[]>;
  createShortcut(input: Record<string, unknown>): Promise<ShortcutRow>;
  updateShortcut(id: string, patch: Record<string, unknown>): Promise<void>;
  deleteShortcut(id: string): Promise<void>;
  batchMove(input: { ids: string[]; targetScope: string }): Promise<void>;
  setVisibleRoles(input: { shortcutId: string; roles: string[] }): Promise<void>;
}

export interface NotificationPrefs {
  actor_id: string;
  enabled: boolean;
  updated_at?: string | null;
}

export interface NotificationsBackend {
  loadPreferences(actorId: string): Promise<NotificationPrefs | null>;
  savePreferences(input: NotificationPrefs): Promise<void>;
  setSessionMuted(input: { sessionId: string; actorId: string; muted: boolean }): Promise<void>;
  listMutedSessionIds(actorId: string): Promise<string[]>;
}

export interface TeamWorkspaceConfigRow {
  team_id: string;
  workspace_path?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TeamWorkspaceConfigBackend {
  load(teamId: string): Promise<TeamWorkspaceConfigRow | null>;
  save(input: TeamWorkspaceConfigRow): Promise<void>;
}

export interface TelemetryBackend {
  insertFeedback(input: Record<string, unknown>): Promise<void>;
  insertSessionReport(input: Record<string, unknown>): Promise<void>;
  insertTelemetryEvent(input: Record<string, unknown>): Promise<void>;
}

export interface TeamClawBackend {
  kind: BackendKind;
  auth: AuthBackend;
  directory: DirectoryBackend;
  sessions: SessionsBackend;
  messages: MessagesBackend;
  runtime: RuntimeBackend;
  attachments: AttachmentsBackend;
  teams: TeamsBackend;
  ideas: IdeasBackend;
  actors: ActorsBackend;
  sessionMembers: SessionMembersBackend;
  shortcuts: ShortcutsBackend;
  notifications: NotificationsBackend;
  teamWorkspaceConfig: TeamWorkspaceConfigBackend;
  telemetry: TelemetryBackend;
}
