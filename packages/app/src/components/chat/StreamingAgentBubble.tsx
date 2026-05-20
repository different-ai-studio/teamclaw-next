import { AlertCircle, CheckCircle2, Circle, Clock3, ListTodo } from "lucide-react";
import type { AgentStreamEntry, StreamingPlanEntry } from "@/stores/v2-streaming-store";
import { cn } from "@/lib/utils";
import { Message, MessageContent, MessageResponse } from "@/packages/ai/message";
import { ToolCallCard } from "./ToolCallCard";
import { ActorLabel } from "./ActorLabel";
import { ThinkingBlock } from "./ThinkingBlock";

function PlanStatusIcon({ status }: { status: StreamingPlanEntry["status"] }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (status === "completed") return <CheckCircle2 className={cn(cls, "text-emerald-500")} />;
  if (status === "in_progress") return <Clock3 className={cn(cls, "text-blue-500")} />;
  return <Circle className={cn(cls, "text-muted-foreground")} />;
}

function InlinePlan({ entries }: { entries: StreamingPlanEntry[] }) {
  if (entries.length === 0) return null;
  const completedCount = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="my-1.5 rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 border-b border-border/50 pb-1.5 text-xs text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5 shrink-0" />
        <span>{completedCount}/{entries.length} done</span>
      </div>
      <div className="space-y-1">
        {entries.map((e, i) => (
          <div
            key={i}
            className={cn("grid grid-cols-[18px_minmax(0,1fr)] items-center gap-2.5", e.status === "completed" && "opacity-65")}
          >
            <div><PlanStatusIcon status={e.status} /></div>
            <div className={cn(
              "text-[13px] leading-6 text-foreground",
              e.status === "completed" && "text-muted-foreground line-through",
            )}>
              <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
              {e.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

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
  // the same content twice. Thinking + tool calls + plan stay visible
  // because the daemon doesn't persist those kinds (per
  // turn_aggregator::supabase_persistent), so the bubble is the only
  // place they survive after the turn ends.
  const showOutput = entry.active && entry.outputText.length > 0;
  const hasToolCalls = entry.toolCalls.length > 0;
  const hasThinking = entry.thinkingText.length > 0;
  const hasPlan = entry.planEntries.length > 0;
  const hasError = !!entry.errorMessage;

  if (!showOutput && !hasToolCalls && !hasThinking && !hasPlan && !hasError) {
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

          {hasPlan && <InlinePlan entries={entry.planEntries} />}

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
