import { AgentType } from "@/lib/proto/amux_pb"

export function resolveAmuxAgentType(
  backendType: string | null | undefined,
  agentKind?: string | null,
): AgentType {
  switch (backendType) {
    case "opencode":
      return AgentType.OPENCODE
    case "codex":
      return AgentType.CODEX
    case "claude":
    case "claude_code":
      return AgentType.CLAUDE_CODE
  }

  switch (agentKind) {
    case "daemon":
    case "amuxd":
    case "opencode":
      return AgentType.OPENCODE
    case "codex":
      return AgentType.CODEX
    default:
      return AgentType.CLAUDE_CODE
  }
}
