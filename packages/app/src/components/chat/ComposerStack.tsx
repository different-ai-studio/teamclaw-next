import * as React from "react";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react";
import { actorAvatarColor } from "@/lib/actor-color";
import { resolveApprovalAnchorActorId } from "@/lib/permission-actor";
import { useActorDisplayName } from "@/hooks/useActorDisplayName";
import { cn } from "@/lib/utils";
import type { Todo } from "@/stores/session-types";
import type { QueuedMessage } from "@/stores/session";
import { PermissionApprovalPanel } from "./PermissionApprovalPanel";
import { ComposerPlanSlot } from "./ComposerPlanSlot";
import {
  composerGlassChildClass,
  composerGlassFillClass,
  composerGlassSurfaceClass,
  composerStackFormSlotClass,
  composerStackShellClass,
} from "./composer-glass";
import { usePendingPermissionsQueue } from "./use-pending-permissions-queue";

export type ActiveStreamingAgent = {
  actorId: string;
  displayName?: string;
};

function ComposerAgentStrip({
  actorId,
  displayNameHint,
  waitingForApproval,
  showInterrupt,
  onInterrupt,
  roundsTop = false,
  embeddedInGlass = false,
}: {
  actorId: string;
  displayNameHint?: string;
  waitingForApproval: boolean;
  showInterrupt: boolean;
  onInterrupt: (agentId: string) => void;
  roundsTop?: boolean;
  embeddedInGlass?: boolean;
}) {
  const { t } = useTranslation();
  const resolvedName = useActorDisplayName(actorId);
  const displayName = displayNameHint || resolvedName || actorId.slice(0, 8);
  const colors = actorAvatarColor(actorId);
  const initial = displayName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div
      className={cn(
        "box-border flex min-h-9 w-full items-center gap-2.5 border-b border-border-soft px-3.5 py-[7px] last:border-b-0",
        embeddedInGlass ? composerGlassChildClass : composerGlassSurfaceClass,
        !embeddedInGlass && roundsTop && "overflow-hidden rounded-t-[14px]",
      )}
      data-testid="streaming-agent-row"
      data-actor-id={actorId}
    >
      <span
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white ring-[1.5px] ring-coral"
        style={{ backgroundColor: colors.bg }}
        aria-hidden
      >
        {initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
        <span className="text-[12.5px] font-semibold text-foreground">{displayName}</span>
        <span
          className={cn(
            "text-[11px] text-faint",
            !waitingForApproval && "text-muted-foreground",
          )}
        >
          {waitingForApproval ? (
            t("chat.streamingBar.waitingApproval", "Waiting for your approval…")
          ) : (
            <>
              {t("chat.streamingBar.streamingActive", "正在回复")}
              <span
                className="ml-1.5 inline-block h-[5px] w-[5px] animate-pulse rounded-full bg-coral align-middle"
                aria-hidden
              />
            </>
          )}
        </span>
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

export function ComposerStack({
  agents,
  onInterrupt,
  todos = [],
  queue = [],
  onRemoveFromQueue,
  planSlotHidden = false,
  children,
}: {
  agents: ReadonlyArray<ActiveStreamingAgent>;
  onInterrupt?: (agentId: string) => void;
  todos?: Todo[];
  queue?: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
  /** Hide plan slot visually but keep state (e.g. while approval card is showing). */
  planSlotHidden?: boolean;
  children: React.ReactNode;
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

  const hasApproval = currentEntry !== null;
  const showAgentSection = agents.length > 0 || showApprovalOnly;
  const showPlan = todos.length > 0 || queue.length > 0;
  const showTopChrome = showAgentSection || showPlan;
  const planRoundsTop = showPlan && !showAgentSection;

  return (
    <div data-testid="composer-stack" className={composerStackShellClass}>
      {showTopChrome ? (
        <div className="box-border w-full overflow-hidden rounded-t-[14px]">
          {showAgentSection ? (
            <div data-testid="streaming-agents-dock" className="box-border w-full">
              <div data-testid="streaming-agent-shell" className="box-border w-full overflow-hidden">
                {hasApproval ? (
                  <div
                    data-testid="composer-approval-glass"
                    className={cn(
                      "box-border w-full overflow-hidden rounded-t-[14px]",
                      composerGlassFillClass,
                    )}
                  >
                    <div
                      className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                      data-testid="pending-permission-expand"
                      data-open="true"
                    >
                      <div className="min-h-0 overflow-hidden">
                        {currentEntry ? (
                          <PermissionApprovalPanel
                            entry={currentEntry}
                            queueIndex={0}
                            queueTotal={queuedCount}
                            onReplyStart={onReplyStart}
                            onReplyRollback={onReplyRollback}
                            appearance="glass"
                            className="box-border w-full border-0 border-b border-border-soft px-3.5 py-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-300"
                          />
                        ) : null}
                      </div>
                    </div>

                    {showApprovalOnly ? null : (
                      agents.map((agent) => {
                        const isAnchor = anchorActorId === agent.actorId && currentEntry !== null;
                        return (
                          <ComposerAgentStrip
                            key={agent.actorId}
                            actorId={agent.actorId}
                            displayNameHint={agent.displayName}
                            waitingForApproval={isAnchor}
                            showInterrupt={Boolean(onInterrupt) && !isAnchor}
                            onInterrupt={onInterrupt ?? (() => {})}
                            embeddedInGlass
                          />
                        );
                      })
                    )}
                  </div>
                ) : (
                  <>
                    <div
                      className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                      data-testid="pending-permission-expand"
                      data-open="false"
                    >
                      <div className="min-h-0 overflow-hidden" />
                    </div>
                    {agents.map((agent, index) => {
                      const isAnchor = anchorActorId === agent.actorId && currentEntry !== null;
                      return (
                        <ComposerAgentStrip
                          key={agent.actorId}
                          actorId={agent.actorId}
                          displayNameHint={agent.displayName}
                          waitingForApproval={isAnchor}
                          showInterrupt={Boolean(onInterrupt) && !isAnchor}
                          onInterrupt={onInterrupt ?? (() => {})}
                          roundsTop={index === 0}
                        />
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          ) : null}

          {showPlan ? (
            <ComposerPlanSlot
              todos={todos}
              queue={queue}
              onRemoveFromQueue={onRemoveFromQueue}
              roundsTop={planRoundsTop}
              hidden={planSlotHidden}
            />
          ) : null}
        </div>
      ) : null}

      <div
        data-testid="composer-input-zone"
        className={cn("relative z-20", composerStackFormSlotClass(showTopChrome))}
      >
        {children}
      </div>
    </div>
  );
}

/** @deprecated Use ComposerStack — kept for tests importing the old name. */
export const StreamingAgentsBar = ComposerStack;
