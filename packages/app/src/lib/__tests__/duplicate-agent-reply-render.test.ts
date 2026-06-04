import { create } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageKind, MessageSchema } from "@/lib/proto/teamclaw_pb";
import { rememberLiveEventId } from "@/lib/live-agent-stream";
import { persistStreamingPartsForReply } from "@/lib/streaming-persist";
import { adaptTeamclawMessages } from "@/lib/v2-message-adapter";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

const FULL =
  "我没有物理位置 — 我运行在云端服务器上，通过 API 为你提供服务。你的请求经过 DeepSeek 的云端推理集群处理后返回结果。";

/** Output deltas from user MQTT log (single delivery). */
const OUTPUT_CHUNKS = [
  "我没有",
  "物理",
  "位置",
  " —",
  " ",
  "我",
  "运行",
  "在",
  "云端",
  "服务器",
  "上",
  "，",
  "通过",
  " API",
  " ",
  "为你",
  "提供服务",
  "。",
  "你的",
  "请求",
  "经过",
  " DeepSeek",
  " ",
  "的",
  "云端",
  "推理",
  "集群",
  "处理后",
  "返回",
  "结果",
  "。",
];

vi.mock("@/lib/local-cache", () => ({
  enrichMessageParts: vi.fn(async (partsJson: string) => partsJson),
  setMessageParts: vi.fn(async (_messageId: string, partsJson: string) => partsJson),
}));

function simulateStream(duplicateDelivery: boolean) {
  const store = useV2StreamingStore.getState();
  const seen = new Set<string>();
  let eventSeq = 0;

  const deliver = (apply: () => void) => {
    const eventId = `evt-${eventSeq++}`;
    const first = rememberLiveEventId(seen, "s1", eventId);
    expect(first).toBe(true);
    if (first) apply();
    if (duplicateDelivery) {
      const second = rememberLiveEventId(seen, "s1", eventId);
      expect(second).toBe(false);
      if (second) apply();
    }
  };

  deliver(() => store.appendThinking("s1", "a1", " where"));
  deliver(() => store.appendThinking("s1", "a1", " I"));
  deliver(() => store.appendThinking("s1", "a1", "'m hosted."));

  for (const chunk of OUTPUT_CHUNKS) {
    deliver(() => store.appendOutput("s1", "a1", chunk));
  }

  return useV2StreamingStore.getState().byKey["s1::a1"];
}

beforeEach(() => {
  useV2StreamingStore.setState({ byKey: {}, archived: [], persistedPlansBySession: {} });
});

describe("duplicate agent reply root-cause checks", () => {
  it("rememberLiveEventId blocks duplicate MQTT envelopes", () => {
    const seen = new Set<string>();
    expect(rememberLiveEventId(seen, "s1", "c246c134")).toBe(true);
    expect(rememberLiveEventId(seen, "s1", "c246c134")).toBe(false);
  });

  it("duplicate acp.output delivery (dedup ON) does not double stream text", () => {
    const entry = simulateStream(true);
    expect(entry?.outputText).toBe(FULL);
    const textParts = entry?.parts.filter((p) => p.type === "text") ?? [];
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe(FULL);
  });

  it("duplicate acp.output without dedup still merges identical chunks", () => {
    const store = useV2StreamingStore.getState();
    for (const chunk of OUTPUT_CHUNKS) {
      store.appendOutput("s1", "a1", chunk);
      store.appendOutput("s1", "a1", chunk);
    }
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry?.outputText).toBe(FULL);
    expect(entry?.parts.filter((p) => p.type === "text")[0]?.text).toBe(FULL);
  });

  it("persist + adapt keeps one text part when stream text matches reply.content", async () => {
    simulateStream(false);
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    const streamText = entry?.outputText ?? "";

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: streamText,
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply);

    const parts = JSON.parse((reply as { partsJson?: string }).partsJson ?? "[]");
    const textParts = parts.filter((p: { type: string }) => p.type === "text");
    expect(textParts).toHaveLength(1);

    const sdk = adaptTeamclawMessages([reply])?.[0];
    expect(sdk?.parts.filter((p) => p.type === "text")).toHaveLength(1);
  });

  it("ingestReplyPreview does not duplicate when content matches stream outputText", () => {
    simulateStream(false);
    const before = useV2StreamingStore.getState().byKey["s1::a1"]?.outputText ?? "";
    useV2StreamingStore.getState().ingestReplyPreview("s1", "a1", before);
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry?.outputText).toBe(before);
    expect(entry?.parts.filter((p) => p.type === "text")).toHaveLength(1);
  });

  it("ingestReplyPreview does not duplicate on whitespace-only daemon final", () => {
    simulateStream(false);
    const streamText = useV2StreamingStore.getState().byKey["s1::a1"]?.outputText ?? "";
    const daemonFinal = streamText.replace("DeepSeek", "DeepSeek ");

    useV2StreamingStore.getState().ingestReplyPreview("s1", "a1", daemonFinal);
    const entry = useV2StreamingStore.getState().byKey["s1::a1"];
    expect(entry?.parts.filter((p) => p.type === "text")).toHaveLength(1);
    expect(entry?.outputText).toBe(daemonFinal.length >= streamText.length ? daemonFinal : streamText);
  });

  it("persist keeps one text part on whitespace-only reply.content mismatch", async () => {
    simulateStream(false);
    const streamText = useV2StreamingStore.getState().byKey["s1::a1"]?.outputText ?? "";
    const daemonFinal = streamText + " ";

    const reply = create(MessageSchema, {
      messageId: "reply-final",
      sessionId: "s1",
      senderActorId: "a1",
      kind: MessageKind.AGENT_REPLY,
      content: daemonFinal,
      turnId: "turn-1",
      createdAt: BigInt(100),
    });

    await persistStreamingPartsForReply("s1", "a1", reply);
    const parts = JSON.parse((reply as { partsJson?: string }).partsJson ?? "[]");
    expect(parts.filter((p: { type: string }) => p.type === "text")).toHaveLength(1);
  });
});
