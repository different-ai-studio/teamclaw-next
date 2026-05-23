import { AlertCircle } from "lucide-react";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { Message, MessageContent, MessageResponse } from "@/packages/ai/message";
import { ToolCallCard } from "./ToolCallCard";
import { ActorLabel } from "./ActorLabel";
import { ThinkingBlock } from "./ThinkingBlock";

// Plan entries used to render inline here as a card. They now surface in
// the TodoList dock above the prompt input (v1 style) — see `planTodos`
// in ChatPanel.tsx. Removed from the bubble to keep the message stream
// focused on conversation content rather than ephemeral planner state.

function ErrorCard({ message, details }: { message: string; details: string }) {
  return (
    <div
      className="my-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs"
      data-testid="v2-streaming-error"
    >
      <div className="flex items-center gap-1.5 text-destructive font-medium mb-1">
        <AlertCircle className="h-3.5 w-3.5" />
        {message}
      </div>
      {details && (
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground max-h-32 overflow-y-auto">
          {details}
        </pre>
      )}
    </div>
  );
}

export function StreamingAgentBubble({ entry }: { entry: AgentStreamEntry }) {
  // After finalize (active=false), the persisted AGENT_REPLY ChatMessage
  // takes over the reply text — suppress outputText here to avoid showing
  // the same content twice. Thinking + tool calls stay visible because the
  // daemon doesn't persist those kinds (per turn_aggregator::supabase_persistent),
  // so the bubble is the only place they survive after the turn ends.
  // Plan entries are NOT rendered here — they surface in the TodoList dock
  // above the prompt input (v1 style).
  const showOutput = entry.active && entry.outputText.length > 0;
  const hasToolCalls = entry.toolCalls.length > 0;
  const hasThinking = entry.thinkingText.length > 0;
  const hasError = !!entry.errorMessage;

  if (!showOutput && !hasToolCalls && !hasThinking && !hasError) {
    return null;
  }

  return (
    <div
      className="mb-1.5"
      data-testid="v2-streaming-agent"
      data-session-id={entry.sessionId}
      data-actor-id={entry.actorId}
      data-active={entry.active ? "true" : "false"}
    >
      <ActorLabel senderActorId={entry.actorId} isUser={false} />
      <Message from="assistant">
        <div className="min-w-0 flex-1">
          {hasThinking && (
            <ThinkingBlock
              content={entry.thinkingText}
              isStreaming={entry.active}
              isOpen={!entry.active}
            />
          )}

          {hasToolCalls && (
            <div className="space-y-1">
              {entry.toolCalls.map((tc) => (
                <div
                  key={tc.id}
                  data-testid="v2-streaming-tool"
                  data-tool-id={tc.id}
                  data-tool-status={tc.status}
                >
                  <ToolCallCard toolCall={tc} />
                </div>
              ))}
            </div>
          )}

          {showOutput && (
            <MessageContent>
              <MessageResponse>{entry.outputText}</MessageResponse>
            </MessageContent>
          )}

          {hasError && (
            <ErrorCard message={entry.errorMessage!} details={entry.errorDetails ?? ""} />
          )}
        </div>
      </Message>
    </div>
  );
}
