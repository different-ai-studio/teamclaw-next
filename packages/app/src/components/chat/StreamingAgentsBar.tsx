import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Square } from "lucide-react";
import { actorAvatarColor } from "@/lib/actor-color";
import { useActorDisplayName } from "@/hooks/useActorDisplayName";
import { cn } from "@/lib/utils";

export type ActiveStreamingAgent = {
  actorId: string;
  displayName?: string;
};

function StreamingAgentCard({
  actorId,
  displayNameHint,
  onInterrupt,
}: {
  actorId: string;
  displayNameHint?: string;
  onInterrupt: (actorId: string) => void;
}) {
  const { t } = useTranslation();
  const resolvedName = useActorDisplayName(actorId);
  const displayName = displayNameHint || resolvedName || actorId.slice(0, 8);
  const colors = actorAvatarColor(actorId);
  const initial = displayName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div
      className="flex items-center gap-1.5 rounded-lg border border-border bg-paper px-2 py-1 shadow-sm"
      data-testid="streaming-agent-row"
      data-actor-id={actorId}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold text-white",
        )}
        style={{ backgroundColor: colors.bg }}
      >
        {initial}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
        {displayName}
      </span>
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-faint" />
      <button
        type="button"
        data-testid="streaming-agent-stop"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-coral/15 text-coral hover:bg-coral/25"
        aria-label={t("chat.interruptAgent", "打断 {{name}}", { name: displayName })}
        onClick={() => onInterrupt(actorId)}
      >
        <Square className="h-2 w-2 fill-current" />
      </button>
    </div>
  );
}

export function StreamingAgentsBar({
  agents,
  onInterrupt,
}: {
  agents: ReadonlyArray<ActiveStreamingAgent>;
  onInterrupt: (actorId: string) => void;
}) {
  if (agents.length === 0) return null;

  return (
    <div
      className="mb-1.5 flex flex-col gap-1"
      data-testid="streaming-agents-bar"
    >
      {agents.map((agent) => (
        <StreamingAgentCard
          key={agent.actorId}
          actorId={agent.actorId}
          displayNameHint={agent.displayName}
          onInterrupt={onInterrupt}
        />
      ))}
    </div>
  );
}
