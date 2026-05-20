export type ConnectedAgent = {
  agentId: string;
  displayName: string;
  agentKind: string;
  permissionLevel: string;
  visibility: "team" | "personal";
  isOwner: boolean;
  deviceId: string | null;
  lastActiveAt: string | null;
};

export type RuntimeInfo = {
  runtimeId: string;
  status: number;
  currentModel: string;
  availableModels: { id: string; displayName: string }[];
  sessionTitle?: string;
  currentPrompt?: string;
  agentType: number;
};

export type AgentAuthorizedHuman = {
  id: string;
  displayName: string;
  permissionLevel: string;
  grantedByActorId: string | null;
  lastActiveAt: string | null;
};
