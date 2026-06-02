import * as React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { isAcpDebugPanelVisible, useAcpDebugStore } from "@/stores/acp-debug-store";

export function AcpStreamDebugPanel({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation();
  const enabled = useAcpDebugStore((s) => s.enabled);
  const allLines = useAcpDebugStore((s) => s.lines);
  const clear = useAcpDebugStore((s) => s.clear);
  const [collapsed, setCollapsed] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const lines = React.useMemo(() => {
    if (!sessionId) return allLines.slice(-80);
    return allLines.filter((l) => l.sessionId === sessionId).slice(-80);
  }, [allLines, sessionId]);

  React.useEffect(() => {
    if (collapsed || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines.length, collapsed]);

  if (!isAcpDebugPanelVisible() || !enabled) return null;

  const copyAll = async () => {
    const text = lines
      .map((l) => {
        const ts = new Date(l.ts).toISOString();
        return `[${ts}] ${l.topic} actor=${l.actorId} case=${l.eventCase}\n${JSON.stringify(l.payload, null, 2)}`;
      })
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn("[acp-debug] copy failed", e);
    }
  };

  return (
    <div
      data-testid="acp-stream-debug-panel"
      className="shrink-0 border-b border-border/80 bg-panel/90"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-faint">
          {t("chat.acpDebug.title", "ACP 流调试")}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {t("chat.acpDebug.lineCount", "{{count}} 条", { count: lines.length })}
          {sessionId
            ? ` · ${t("chat.acpDebug.scopeCurrentSession", "当前会话")}`
            : ` · ${t("chat.acpDebug.scopeAll", "全部")}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copyAll()}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
            title={t("chat.acpDebug.copy", "复制")}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={clear}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
            title={t("chat.acpDebug.clear", "清空")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground"
          >
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {!collapsed ? (
        <div
          ref={scrollRef}
          className={cn(
            "max-h-[min(28vh,220px)] overflow-auto px-3 pb-2",
            "font-mono text-[10.5px] leading-relaxed text-ink-2",
          )}
        >
          {lines.length === 0 ? (
            <p className="py-2 text-muted-foreground">
              {t("chat.acpDebug.waiting", "等待 {{token}} …", { token: "acp.event" })}
            </p>
          ) : (
            lines.map((line) => (
              <pre
                key={line.id}
                className="mb-2 whitespace-pre-wrap break-all rounded border border-border-soft bg-paper/80 p-2 last:mb-0"
              >
                {`${new Date(line.ts).toISOString()}  ${line.eventCase}\n${line.topic}\n${JSON.stringify(line.payload, null, 2)}`}
              </pre>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
