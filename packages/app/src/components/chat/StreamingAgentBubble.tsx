import { AlertCircle } from "lucide-react";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { Message, MessageContent, MessageResponse } from "@/packages/ai/message";
import { useStreamRevealText } from "@/hooks/useStreamRevealText";
import { ToolCallCard } from "./ToolCallCard";
import { ActorLabel } from "./ActorLabel";
import { ThinkingBlock } from "./ThinkingBlock";
import type { MessagePart } from "@/stores/session-types";

function StreamRevealedResponse({
  text,
  reveal,
}: {
  text: string;
  reveal: boolean;
}) {
  const displayed = useStreamRevealText(text, reveal);
  return (
    <MessageContent>
      <MessageResponse>{displayed}</MessageResponse>
    </MessageContent>
  );
}

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

function renderOrderedPart(
  part: MessagePart,
  showText: boolean,
  isStreamingReasoning: boolean,
  revealText: boolean,
) {
  if (part.type === "reasoning") {
    const text = part.text || part.content || "";
    if (!text) return null;
    return (
      <ThinkingBlock
        key={part.id}
        content={text}
        isStreaming={isStreamingReasoning}
        isOpen={false}
      />
    );
  }

  if (part.type === "tool-call" && part.toolCall) {
    return (
      <div
        key={part.id}
        data-testid="v2-streaming-tool"
        data-tool-id={part.toolCall.id}
        data-tool-status={part.toolCall.status}
      >
        <ToolCallCard toolCall={part.toolCall} />
      </div>
    );
  }

  if (!showText || part.type !== "text") return null;
  const text = part.text || part.content || "";
  if (!text) return null;
  return (
    <StreamRevealedResponse key={part.id} text={text} reveal={revealText} />
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
  const orderedParts = entry.parts.filter(
    (part) =>
      (part.type === "reasoning" && Boolean(part.text || part.content)) ||
      (part.type === "text" && Boolean(part.text || part.content)) ||
      (part.type === "tool-call" && Boolean(part.toolCall)),
  );
  const isArchived = "archiveId" in entry;
  const showText = entry.active || !isArchived;
  const visibleOrderedParts = orderedParts.filter(
    (part) => part.type === "reasoning" || part.type === "tool-call" || showText,
  );
  const hasVisibleOrderedParts = visibleOrderedParts.length > 0;
  const showOutput =
    showText && !hasVisibleOrderedParts && entry.outputText.length > 0;
  const hasFallbackToolCalls = !hasVisibleOrderedParts && entry.toolCalls.length > 0;
  const hasOrderedThinking = orderedParts.some((part) => part.type === "reasoning");
  const hasThinking = !hasOrderedThinking && entry.thinkingText.length > 0;
  const hasError = !!entry.errorMessage;
  const lastLiveTextPartIndex = entry.active
    ? visibleOrderedParts.findLastIndex((part) => part.type === "text")
    : -1;

  if (!hasVisibleOrderedParts && !showOutput && !hasFallbackToolCalls && !hasThinking && !hasError) {
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
              isOpen={false}
            />
          )}

          {hasVisibleOrderedParts && (
            <div className="space-y-1">
              {visibleOrderedParts.map((part, index) =>
                renderOrderedPart(
                  part,
                  showText,
                  entry.active &&
                    part.type === "reasoning" &&
                    index === visibleOrderedParts.length - 1,
                  entry.active &&
                    part.type === "text" &&
                    index === lastLiveTextPartIndex,
                ),
              )}
            </div>
          )}

          {hasFallbackToolCalls && (
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
            <StreamRevealedResponse text={entry.outputText} reveal={entry.active} />
          )}

          {hasError && (
            <ErrorCard message={entry.errorMessage!} details={entry.errorDetails ?? ""} />
          )}
        </div>
      </Message>
    </div>
  );
}
