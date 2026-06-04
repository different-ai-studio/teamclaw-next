import * as React from "react";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react";
import { actorAvatarColor } from "@/lib/actor-color";
import { resolveApprovalAnchorActorId } from "@/lib/permission-actor";
import { useActorDisplayName } from "@/hooks/useActorDisplayName";
import { cn } from "@/lib/utils";
import type { PendingPermissionEntry } from "@/stores/session-types";
import { PermissionApprovalPanel } from "./PermissionApprovalPanel";
import { usePendingPermissionsQueue } from "./use-pending-permissions-queue";

export type ActiveStreamingAgent = {
  actorId: string;
  displayName?: string;
};

function AgentStatusRow({
  actorId,
  displayNameHint,
  waitingForApproval,
  showInterrupt,
  onInterrupt,
}: {
  actorId: string;
  displayNameHint?: string;
  waitingForApproval: boolean;
  showInterrupt: boolean;
  onInterrupt: (actorId: string) => void;
}) {
  const { t } = useTranslation();
  const resolvedName = useActorDisplayName(actorId);
  const displayName = displayNameHint || resolvedName || actorId.slice(0, 8);
  const colors = actorAvatarColor(actorId);
  const initial = displayName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div
      className="flex min-h-10 items-center gap-2.5 px-3 py-2"
      data-testid="streaming-agent-row"
      data-actor-id={actorId}
    >
      <span
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white"
        style={{ backgroundColor: colors.bg }}
        aria-hidden
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-foreground">
          {displayName}
        </div>
        <div className="truncate text-[11px] text-faint">
          {waitingForApproval ? (
            <span>
              {t("chat.streamingBar.waitingApproval", "Waiting for your approval…")}
            </span>
          ) : (
            <span className="motion-safe:animate-pulse">
              {t("chat.streamingBar.streaming", "Streaming…")}
            </span>
          )}
        </div>
      </div>
      {showInterrupt ? (
        <button
          type="button"
          data-testid="streaming-agent-stop"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-coral/15 text-coral transition-colors hover:bg-coral/25"
          aria-label={t("chat.interruptAgent", "Interrupt {{name}}", { name: displayName })}
          onClick={() => onInterrupt(actorId)}
        >
          <Square className="h-2.5 w-2.5 fill-current" />
        </button>
      ) : null}
    </div>
  );
}

function StreamingAgentDockShell({
  actorId,
  displayNameHint,
  showAgentRow,
  waitingForApproval,
  approvalEntry,
  queueIndex,
  queueTotal,
  onInterrupt,
  onReplyStart,
  onReplyRollback,
}: {
  actorId: string | null;
  displayNameHint?: string;
  showAgentRow: boolean;
  waitingForApproval: boolean;
  approvalEntry: PendingPermissionEntry | null;
  queueIndex: number;
  queueTotal: number;
  onInterrupt: (actorId: string) => void;
  onReplyStart?: (permissionId: string) => void;
  onReplyRollback?: (permissionId: string) => void;
}) {
  const hasApproval = approvalEntry !== null;

  return (
    <div
      data-testid={showAgentRow ? "streaming-agent-shell" : "pending-permission-shell"}
      data-actor-id={actorId ?? undefined}
      className="overflow-hidden rounded-[14px] border border-border bg-paper shadow-sm transition-[border-color,box-shadow] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          hasApproval ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        data-testid="pending-permission-expand"
        data-open={hasApproval ? "true" : "false"}
      >
        <div className="min-h-0 overflow-hidden">
          {approvalEntry ? (
            <PermissionApprovalPanel
              entry={approvalEntry}
              queueIndex={queueIndex}
              queueTotal={queueTotal}
              onReplyStart={onReplyStart}
              onReplyRollback={onReplyRollback}
              className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-300"
            />
          ) : null}
        </div>
      </div>

      {showAgentRow && actorId ? (
        <AgentStatusRow
          actorId={actorId}
          displayNameHint={displayNameHint}
          waitingForApproval={waitingForApproval}
          showInterrupt={!hasApproval}
          onInterrupt={onInterrupt}
        />
      ) : null}
    </div>
  );
}

export function StreamingAgentsDock({
  agents,
  onInterrupt,
}: {
  agents: ReadonlyArray<ActiveStreamingAgent>;
  onInterrupt: (actorId: string) => void;
}) {
  const {
    sessionPermissionMode,
    currentEntry,
    queuedCount,
    onReplyStart,
    onReplyRollback,
  } = usePendingPermissionsQueue();

  const streamingActorIds = React.useMemo(
    () => agents.map((agent) => agent.actorId),
    [agents],
  );

  const anchorActorId = React.useMemo(
    () => resolveApprovalAnchorActorId(currentEntry, streamingActorIds),
    [currentEntry, streamingActorIds],
  );

  const showApprovalOnly =
    currentEntry !== null &&
    agents.length === 0 &&
    sessionPermissionMode !== "fullAccess";

  const showStreamingDock =
    agents.length > 0 || showApprovalOnly;

  if (!showStreamingDock) return null;

  if (showApprovalOnly) {
    return (
      <div
        data-testid="streaming-agents-dock"
        className="mb-1.5 flex flex-col gap-1"
      >
        <div data-testid="pending-permission-inline" className="w-full">
          <StreamingAgentDockShell
            actorId={null}
            showAgentRow={false}
            waitingForApproval={false}
            approvalEntry={currentEntry}
            queueIndex={0}
            queueTotal={queuedCount}
            onInterrupt={onInterrupt}
            onReplyStart={onReplyStart}
            onReplyRollback={onReplyRollback}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="streaming-agents-dock"
      className="mb-1.5 flex flex-col gap-1"
    >
      {agents.map((agent) => {
        const isAnchor = anchorActorId === agent.actorId && currentEntry !== null;
        return (
          <StreamingAgentDockShell
            key={agent.actorId}
            actorId={agent.actorId}
            displayNameHint={agent.displayName}
            showAgentRow
            waitingForApproval={isAnchor}
            approvalEntry={isAnchor ? currentEntry : null}
            queueIndex={0}
            queueTotal={queuedCount}
            onInterrupt={onInterrupt}
            onReplyStart={onReplyStart}
            onReplyRollback={onReplyRollback}
          />
        );
      })}
    </div>
  );
}

/** @deprecated Use StreamingAgentsDock — kept for tests importing the old name. */
export const StreamingAgentsBar = StreamingAgentsDock;
