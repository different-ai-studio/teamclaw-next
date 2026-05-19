import type { SessionDetailConnectionState } from "../session-detail-controller";

export type SessionComposerPresentation = {
  canSend: boolean;
  helperText: string | null;
  isDisabled: boolean;
  placeholder: string;
  sendLabel: string;
};

export function buildComposerPresentation(input: {
  composerText: string;
  connectionState: SessionDetailConnectionState;
  isSending: boolean;
  sendErrorMessage: string | null;
}): SessionComposerPresentation {
  const trimmed = input.composerText.trim();

  if (input.connectionState === "connecting") {
    return {
      canSend: false,
      helperText: input.sendErrorMessage ?? "正在连接实时通道，连上后就可以发送。",
      isDisabled: true,
      placeholder: "正在连接实时通道…",
      sendLabel: input.isSending ? "发送中…" : "发送",
    };
  }

  if (input.connectionState === "disconnected") {
    return {
      canSend: false,
      helperText: input.sendErrorMessage ?? "实时连接暂时不可用，仍可稍后重试发送。",
      isDisabled: true,
      placeholder: "等待实时连接恢复后继续发送。",
      sendLabel: input.isSending ? "发送中…" : "发送",
    };
  }

  return {
    canSend: trimmed.length > 0 && !input.isSending,
    helperText: input.sendErrorMessage,
    isDisabled: trimmed.length === 0 || input.isSending,
    placeholder: "发送消息到这个会话",
    sendLabel: input.isSending ? "发送中…" : "发送",
  };
}
