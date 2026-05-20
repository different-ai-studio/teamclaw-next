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

export function isAgentOnline(agent: Pick<ConnectedAgent, "lastActiveAt">, now = Date.now()): boolean {
  if (!agent.lastActiveAt) return false;
  const t = Date.parse(agent.lastActiveAt);
  if (!Number.isFinite(t)) return false;
  return now - t < 120_000;
}
