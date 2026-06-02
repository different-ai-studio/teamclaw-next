import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  launchV2E2EApp,
  stopV2E2EApp,
  cleanupV2,
  v2Call,
  waitForSelector,
  waitForText,
  domCount,
  domText,
} from "../_utils/v2-app";
import { executeJs } from "../../_utils/tauri-mcp-test-utils";

// ── local helpers ────────────────────────────────────────────────────────────
const RUN_PREFIX = `si-${Date.now().toString(36)}`;
let runCounter = 0;
function nextRunId(prefix: string): string {
  runCounter += 1;
  return `${RUN_PREFIX}-${prefix}-${runCounter}`;
}
function id(runId: string, suffix: string): string {
  return `${runId}-${suffix}`;
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error(`waitFor timed out: ${label} (last=${JSON.stringify(last)})`);
}

async function textOccurrences(selector: string, text: string): Promise<number> {
  if (!text) throw new Error("textOccurrences: needle must not be empty");
  const code = `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "0";
      const hay = el.textContent || "";
      const needle = ${JSON.stringify(text)};
      if (!needle) return "0";
      let count = 0, idx = 0;
      while ((idx = hay.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
      return String(count);
    })()
  `;
  return Number(await executeJs(code));
}

async function seedSingleAgentSession(opts: {
  runId: string;
  sessionId: string;
  memberId: string;
  agentId: string;
  title: string;
}): Promise<void> {
  await v2Call("seedConversation", {
    runId: opts.runId,
    teamId: `${opts.runId}-team`,
    workspacePath: `/tmp/${opts.runId}-workspace`,
    actors: [
      { id: opts.memberId, actorType: "member", displayName: "你" },
      { id: opts.agentId, actorType: "agent", displayName: "Claw" },
    ],
    sessions: [
      {
        id: opts.sessionId,
        title: opts.title,
        lastMessageAt: new Date().toISOString(),
        lastMessagePreview: "等待输入",
        participantActorIds: [opts.memberId, opts.agentId],
      },
    ],
    activeSessionId: opts.sessionId,
  });
}

describe("V2 PR streaming integrity (spec D8/D9)", () => {
  beforeAll(async () => {
    await launchV2E2EApp();
  });

  beforeEach(async () => {
    await cleanupV2();
  });

  afterAll(async () => {
    await stopV2E2EApp();
  });
});
