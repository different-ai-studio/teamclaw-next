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
}

export interface DirectoryBackend {
  resolveCurrentMemberActor(teamId: string, userId: string): Promise<DirectoryMemberActor | null>;
}

export interface TeamClawBackend {
  kind: BackendKind;
  auth: AuthBackend;
  directory: DirectoryBackend;
  sessions: SessionsBackend;
  messages: MessagesBackend;
  runtime: RuntimeBackend;
  attachments: AttachmentsBackend;
}
