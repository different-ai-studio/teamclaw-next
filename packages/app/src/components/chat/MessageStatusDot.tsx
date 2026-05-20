import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOutboxStore } from "@/stores/outbox-store";
import { cn } from "@/lib/utils";

/** Per-bubble outbox status dot. Reads the live outbox entry for `messageId`;
 * if none exists the message has either never been outboxed (historical row
 * from Supabase) or has been GC'd after delivery — in both cases the dot is
 * hidden. Mirrors iOS `OutboxStatusDot`. */
export function MessageStatusDot({ messageId }: { messageId: string }) {
  const entry = useOutboxStore((s) => s.byId[messageId]);
  const retry = useOutboxStore((s) => s.retry);
  const { t } = useTranslation();
  if (!entry) return null;

  if (entry.state === "delivered") {
    return (
      <span
        className="inline-flex h-4 w-4 items-center justify-center"
        title={t("chat.sendStatus.delivered", "Delivered")}
        data-testid="msg-status-delivered"
      >
        <Check className="h-3 w-3 text-muted-foreground/60" />
      </span>
    );
  }

  if (entry.state === "failed") {
    return (
      <button
        type="button"
        onClick={() => void retry(entry.messageId)}
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded-full",
          "text-destructive hover:bg-destructive/10 transition-colors",
        )}
        title={
          entry.lastError
            ? `${t("chat.sendStatus.failedClickToRetry", "Failed — click to retry")}: ${entry.lastError}`
            : t("chat.sendStatus.failedClickToRetry", "Failed — click to retry")
        }
        data-testid="msg-status-failed"
      >
        <AlertCircle className="h-3.5 w-3.5" />
      </button>
    );
  }

  // pending or inFlight — same visual (a spinner). UI doesn't distinguish
  // "waiting in queue" from "actively sending" — both are "in transit"
  // from the user's perspective.
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center"
      title={t("chat.sendStatus.sending", "Sending…")}
      data-testid="msg-status-sending"
    >
      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/70" />
    </span>
  );
}
