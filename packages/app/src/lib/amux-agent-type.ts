import { AgentType } from "@/lib/proto/amux_pb"

export function resolveAmuxAgentType(
  backendType: string | null | undefined,
): AgentType {
  switch (backendType) {
    case "opencode":
      return AgentType.OPENCODE
    case "codex":
      return AgentType.CODEX
    case "claude-code":
    case "claude":
    case "claude_code":
      return AgentType.CLAUDE_CODE
  }

  return AgentType.CLAUDE_CODE
}
