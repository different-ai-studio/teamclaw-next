import * as React from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

export function StreamingAgentBubble({
  entry,
  displayName,
}: {
  entry: AgentStreamEntry;
  displayName: string;
}) {
  const hasOutput = entry.outputText.length > 0;
  const hasThinking = entry.thinkingText.length > 0;
  const hasToolCalls = entry.toolCalls.length > 0;

  return (
    <div className="flex items-start gap-2 px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium">{displayName}</span>
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        </div>

        {hasThinking && (
          <ThinkingBlock content={entry.thinkingText} isStreaming />
        )}

        {hasToolCalls && (
          <div className="space-y-1">
            {entry.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {hasOutput && (
          <div className="text-sm whitespace-pre-wrap break-words">
            {entry.outputText}
          </div>
        )}

        {!hasOutput && !hasThinking && !hasToolCalls && (
          <div className="text-sm text-muted-foreground italic">Working...</div>
        )}
      </div>
    </div>
  );
}
