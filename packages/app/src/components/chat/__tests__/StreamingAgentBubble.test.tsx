import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { StreamingAgentBubble } from "../StreamingAgentBubble";
import { selectStreamsForSession, useV2StreamingStore } from "@/stores/v2-streaming-store";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(),
}));

beforeEach(() => {
  useV2StreamingStore.setState({ byKey: {}, archived: [] });
});

async function flushStreamReveal() {
  for (let i = 0; i < 40; i += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }
}

describe("StreamingAgentBubble", () => {
  it("does not render an archived text-only stream after persisted reply takes over", () => {
    const { container } = render(
      <StreamingAgentBubble
        entry={{
          sessionId: "s1",
          actorId: "agent-a",
          outputText: "Persisted reply text.",
          thinkingText: "",
          parts: [
            {
              id: "archived-text",
              type: "text",
              text: "Persisted reply text.",
              content: "Persisted reply text.",
            },
          ],
          toolCalls: [],
          planEntries: [],
          pendingPermission: null,
          errorMessage: null,
          errorDetails: null,
          lastUpdate: Date.now(),
          active: false,
          archiveId: "s1::agent-a::1",
        }}
      />,
    );

    expect(container.textContent).toBe("");
  });

  it("keeps archived tool calls visible without duplicating archived reply text", () => {
    const { container } = render(
      <StreamingAgentBubble
        entry={{
          sessionId: "s1",
          actorId: "agent-a",
          outputText: "Before tool.After tool.",
          thinkingText: "",
          parts: [
            {
              id: "text-before",
              type: "text",
              text: "Before tool.",
              content: "Before tool.",
            },
            {
              id: "tool-1",
              type: "tool-call",
              toolCallId: "tool-1",
              toolCall: {
                id: "tool-1",
                name: "grep",
                status: "completed",
                arguments: { pattern: "needle" },
                result: "result",
                startTime: new Date(0),
              },
            },
            {
              id: "text-after",
              type: "text",
              text: "After tool.",
              content: "After tool.",
            },
          ],
          toolCalls: [
            {
              id: "tool-1",
              name: "grep",
              status: "completed",
              arguments: { pattern: "needle" },
              result: "result",
              startTime: new Date(0),
            },
          ],
          planEntries: [],
          pendingPermission: null,
          errorMessage: null,
          errorDetails: null,
          lastUpdate: Date.now(),
          active: false,
          archiveId: "s1::agent-a::1",
        }}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Grep");
    expect(text).not.toContain("Before tool.");
    expect(text).not.toContain("After tool.");
  });

  it("keeps current turn text visible after terminal status before final message is appended", () => {
    const { container } = render(
      <StreamingAgentBubble
        entry={{
          sessionId: "s1",
          actorId: "agent-a",
          outputText: "Final text from stream.",
          thinkingText: "",
          parts: [
            {
              id: "text-final",
              type: "text",
              text: "Final text from stream.",
              content: "Final text from stream.",
            },
          ],
          toolCalls: [],
          planEntries: [],
          pendingPermission: null,
          errorMessage: null,
          errorDetails: null,
          lastUpdate: Date.now(),
          active: false,
        }}
      />,
    );

    expect(container.textContent).toContain("Final text from stream.");
  });

  it("renders text from a store stream after finishSessionActor marks it inactive", () => {
    const store = useV2StreamingStore.getState();
    store.appendOutput("s1", "agent-a", "Live answer.");
    store.finishSessionActor("s1", "agent-a");

    const [entry] = selectStreamsForSession(useV2StreamingStore.getState(), "s1");
    const { container } = render(<StreamingAgentBubble entry={entry} />);

    expect(entry.active).toBe(false);
    expect(container.textContent).toContain("Live answer.");
  });

  it("renders live text and tool calls in ACP event order", async () => {
    const { container } = render(
      <StreamingAgentBubble
        entry={{
          sessionId: "s1",
          actorId: "agent-a",
          outputText: "Before tool.After tool.",
          thinkingText: "",
          parts: [
            {
              id: "text-before",
              type: "text",
              text: "Before tool.",
              content: "Before tool.",
            },
            {
              id: "tool-1",
              type: "tool-call",
              toolCallId: "tool-1",
              toolCall: {
                id: "tool-1",
                name: "grep",
                status: "completed",
                arguments: { pattern: "needle" },
                result: "result",
                startTime: new Date(0),
              },
            },
            {
              id: "text-after",
              type: "text",
              text: "After tool.",
              content: "After tool.",
            },
          ],
          toolCalls: [
            {
              id: "tool-1",
              name: "grep",
              status: "completed",
              arguments: { pattern: "needle" },
              result: "result",
              startTime: new Date(0),
            },
          ],
          planEntries: [],
          pendingPermission: null,
          errorMessage: null,
          errorDetails: null,
          lastUpdate: Date.now(),
          active: true,
        }}
      />,
    );

    await flushStreamReveal();
    await waitFor(() => {
      const text = container.textContent ?? "";
      const beforeIndex = text.indexOf("Before tool.");
      const toolIndex = text.indexOf("Grep");
      const afterIndex = text.indexOf("After tool.");
      expect(beforeIndex).toBeGreaterThanOrEqual(0);
      expect(toolIndex).toBeGreaterThanOrEqual(0);
      expect(afterIndex).toBeGreaterThanOrEqual(0);
      expect(beforeIndex).toBeLessThan(toolIndex);
      expect(toolIndex).toBeLessThan(afterIndex);
    });
  });

  it("renders independent thinking blocks in ACP event order and collapses completed ones", async () => {
    const { container } = render(
      <StreamingAgentBubble
        entry={{
          sessionId: "s1",
          actorId: "agent-a",
          outputText: "Before tool.",
          thinkingText: "Plan first.Plan second.Plan third.",
          parts: [
            {
              id: "thinking-1",
              type: "reasoning",
              text: "Plan first.",
              content: "Plan first.",
            },
            {
              id: "text-before",
              type: "text",
              text: "Before tool.",
              content: "Before tool.",
            },
            {
              id: "thinking-2",
              type: "reasoning",
              text: "Plan second.",
              content: "Plan second.",
            },
            {
              id: "tool-1",
              type: "tool-call",
              toolCallId: "tool-1",
              toolCall: {
                id: "tool-1",
                name: "grep",
                status: "completed",
                arguments: { pattern: "needle" },
                result: "/tmp/project",
                startTime: new Date(0),
              },
            },
            {
              id: "thinking-3",
              type: "reasoning",
              text: "Plan third.",
              content: "Plan third.",
            },
          ],
          toolCalls: [
            {
              id: "tool-1",
              name: "grep",
              status: "completed",
              arguments: { pattern: "needle" },
              result: "/tmp/project",
              startTime: new Date(0),
            },
          ],
          planEntries: [],
          pendingPermission: null,
          errorMessage: null,
          errorDetails: null,
          lastUpdate: Date.now(),
          active: true,
        }}
      />,
    );

    await flushStreamReveal();
    await waitFor(() => {
      expect(container.textContent ?? "").toContain("Plan third.");
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Plan first.");
    expect(text).not.toContain("Plan second.");

    const thinkingButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Thinking Process"),
    );
    expect(thinkingButtons).toHaveLength(2);

    fireEvent.click(thinkingButtons[0]);
    fireEvent.click(thinkingButtons[1]);

    const expandedText = container.textContent ?? "";
    const firstThinkingIndex = expandedText.indexOf("Plan first.");
    const beforeIndex = expandedText.indexOf("Before tool.");
    const secondThinkingIndex = expandedText.indexOf("Plan second.");
    const toolIndex = expandedText.indexOf("Grep");
    const thirdThinkingIndex = expandedText.indexOf("Plan third.");

    expect(firstThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(beforeIndex).toBeGreaterThanOrEqual(0);
    expect(secondThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(thirdThinkingIndex).toBeGreaterThanOrEqual(0);
    expect(firstThinkingIndex).toBeLessThan(beforeIndex);
    expect(beforeIndex).toBeLessThan(secondThinkingIndex);
    expect(secondThinkingIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(thirdThinkingIndex);
  });

  it("keeps finished thinking blocks collapsed until opened", () => {
    const { container } = render(
      <StreamingAgentBubble
        entry={{
          sessionId: "s1",
          actorId: "agent-a",
          outputText: "Before tool.",
          thinkingText: "Plan first.Plan second.",
          parts: [
            {
              id: "thinking-1",
              type: "reasoning",
              text: "Plan first.",
              content: "Plan first.",
            },
            {
              id: "text-before",
              type: "text",
              text: "Before tool.",
              content: "Before tool.",
            },
            {
              id: "thinking-2",
              type: "reasoning",
              text: "Plan second.",
              content: "Plan second.",
            },
          ],
          toolCalls: [],
          planEntries: [],
          pendingPermission: null,
          errorMessage: null,
          errorDetails: null,
          lastUpdate: Date.now(),
          active: false,
        }}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("Plan first.");
    expect(text).not.toContain("Plan second.");
    expect(text).toContain("Before tool.");

    const thinkingButtons = Array.from(container.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Thinking Process"),
    );
    expect(thinkingButtons).toHaveLength(2);

    fireEvent.click(thinkingButtons[0]);
    fireEvent.click(thinkingButtons[1]);

    const expandedText = container.textContent ?? "";
    expect(expandedText).toContain("Plan first.");
    expect(expandedText).toContain("Plan second.");
  });
});
