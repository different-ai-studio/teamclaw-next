# Expo / iOS Parity Batch 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the runtime/+/state proto decoder, add the AgentConfigSheet (workspace + agent type), and replace the static slash command list with agent-announced commands plus iOS-equivalent built-in fallback.

**Architecture:** Three independent feature blocks. Task A unblocks runtime data flow; Task C consumes that flow; Task B is orthogonal UI. All three build on infrastructure landed in Batch 2.

**Tech Stack:** Expo Router · React Native · TypeScript · `@bufbuild/protobuf` · Vitest

**Spec:** [`docs/superpowers/specs/2026-05-20-expo-ios-parity-batch-3-design.md`](../specs/2026-05-20-expo-ios-parity-batch-3-design.md)

---

## File Structure

### Task A — RuntimeInfo decoder
- Modify: `apps/expo/src/features/actors/connected-agent-types.ts` — extend `RuntimeInfo` shape
- Rewrite: `apps/expo/src/lib/teamclaw/runtime-info.ts` — real decoder
- Create: `apps/expo/src/test/runtime-info.test.ts`

### Task B — AgentConfigSheet
- Create: `apps/expo/src/features/sessions/components/AgentConfigSheet.tsx`
- Modify: `apps/expo/src/features/sessions/screens/NewSessionScreen.tsx` — open sheet for agent type
- Create: `apps/expo/src/test/agent-config-sheet.test.tsx`

### Task C — Dynamic slash commands
- Modify: `apps/expo/src/features/sessions/components/slash-commands.ts` — align `SlashCommand` shape with iOS, switch fallback to built-in list
- Create: `apps/expo/src/features/sessions/components/runtime-commands.ts` — resolver
- Modify: `apps/expo/app/_layout.tsx` — export `useConnectedAgentsStore()` hook
- Modify: `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx` — thread dynamic commands into composer
- Modify: `apps/expo/src/features/sessions/components/SessionComposerShell.tsx` — accept dynamic commands prop
- Create: `apps/expo/src/test/runtime-commands.test.ts`
- Modify: `apps/expo/src/test/slash-commands.test.ts` — adjust to new shape

---

# Task A — Decode RuntimeInfo proto

## Task A.1: Extend RuntimeInfo type

**Files:**
- Modify: `apps/expo/src/features/actors/connected-agent-types.ts`

- [ ] **Step 1: Read current type**

`apps/expo/src/features/actors/connected-agent-types.ts` currently has a 7-field `RuntimeInfo`. Extend it.

- [ ] **Step 2: Replace the `RuntimeInfo` block with the extended shape**

```ts
export type RuntimeAvailableCommand = {
  name: string;
  description: string;
  inputHint: string;
};

export type RuntimeInfo = {
  runtimeId: string;
  agentType: number;
  worktree: string;
  branch: string;
  status: number;
  startedAt: number;
  currentPrompt: string;
  workspaceId: string;
  sessionTitle: string;
  toolUseCount: number;
  availableModels: { id: string; displayName: string }[];
  currentModel: string;
  state: number;
  stage: string;
  errorCode: string;
  errorMessage: string;
  failedStage: string;
  availableCommands: RuntimeAvailableCommand[];
};
```

- [ ] **Step 3: Type-check**

Run from repo root: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: only pre-existing AuthScreen error. Test files that construct `RuntimeInfo` may now break — look for `connected-agents-store.test.ts` and `runtime-state-subscriber.test.ts`. If they break, extend the test fixtures with the new required fields (use empty defaults: `""` for strings, `0` for numbers, `[]` for arrays).

- [ ] **Step 4: Update broken test fixtures if any**

In each test file that builds a `RuntimeInfo`, ensure all new required fields are present with safe defaults. Example fixture:

```ts
const baseRuntimeInfo: RuntimeInfo = {
  runtimeId: "r1",
  agentType: 1,
  worktree: "",
  branch: "",
  status: 1,
  startedAt: 0,
  currentPrompt: "",
  workspaceId: "",
  sessionTitle: "",
  toolUseCount: 0,
  availableModels: [],
  currentModel: "",
  state: 0,
  stage: "",
  errorCode: "",
  errorMessage: "",
  failedStage: "",
  availableCommands: [],
};
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @teamclaw/expo test`
Expected: 213 still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/expo/src/features/actors/connected-agent-types.ts apps/expo/src/test/
git commit -m "feat(expo): extend RuntimeInfo type with proto fields"
```

---

## Task A.2: Real decodeRuntimeInfo

**Files:**
- Rewrite: `apps/expo/src/lib/teamclaw/runtime-info.ts`
- Create: `apps/expo/src/test/runtime-info.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/runtime-info.test.ts
import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import { RuntimeInfoSchema, AcpAvailableCommandSchema, ModelInfoSchema } from "@teamclaw/app/proto/amux_pb";

import { decodeRuntimeInfo } from "../lib/teamclaw/runtime-info";

describe("decodeRuntimeInfo", () => {
  it("decodes a roundtripped RuntimeInfo", () => {
    const proto = create(RuntimeInfoSchema, {
      runtimeId: "r1",
      agentType: 1,
      worktree: "/repo",
      branch: "main",
      status: 1,
      startedAt: BigInt(1234567890),
      currentPrompt: "",
      workspaceId: "ws-1",
      sessionTitle: "Hello",
      toolUseCount: 3,
      availableModels: [
        create(ModelInfoSchema, { id: "m1", displayName: "Model 1" }),
      ],
      currentModel: "m1",
      state: 2,
      stage: "",
      errorCode: "",
      errorMessage: "",
      failedStage: "",
      availableCommands: [
        create(AcpAvailableCommandSchema, { name: "clear", description: "Clear chat", inputHint: "" }),
        create(AcpAvailableCommandSchema, { name: "model", description: "Switch", inputHint: "name" }),
      ],
    });
    const payload = toBinary(RuntimeInfoSchema, proto);
    const decoded = decodeRuntimeInfo(payload);
    expect(decoded).not.toBeNull();
    expect(decoded?.runtimeId).toBe("r1");
    expect(decoded?.workspaceId).toBe("ws-1");
    expect(decoded?.toolUseCount).toBe(3);
    expect(decoded?.availableModels).toEqual([{ id: "m1", displayName: "Model 1" }]);
    expect(decoded?.availableCommands).toEqual([
      { name: "clear", description: "Clear chat", inputHint: "" },
      { name: "model", description: "Switch", inputHint: "name" },
    ]);
    expect(decoded?.startedAt).toBe(1234567890);
  });

  it("returns null on malformed payload", () => {
    expect(decodeRuntimeInfo(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
  });

  it("returns empty arrays for missing collections", () => {
    const proto = create(RuntimeInfoSchema, { runtimeId: "r1" });
    const payload = toBinary(RuntimeInfoSchema, proto);
    const decoded = decodeRuntimeInfo(payload);
    expect(decoded?.availableCommands).toEqual([]);
    expect(decoded?.availableModels).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run from repo root: `pnpm --filter @teamclaw/expo test src/test/runtime-info.test.ts`
Expected: FAIL — current decoder returns null for all payloads.

- [ ] **Step 3: Rewrite decoder**

```ts
// apps/expo/src/lib/teamclaw/runtime-info.ts
import { fromBinary } from "@bufbuild/protobuf";
import { RuntimeInfoSchema } from "@teamclaw/app/proto/amux_pb";

import type { RuntimeInfo } from "../../features/actors/connected-agent-types";

export function decodeRuntimeInfo(payload: Uint8Array): RuntimeInfo | null {
  try {
    const proto = fromBinary(RuntimeInfoSchema, payload);
    return {
      runtimeId: proto.runtimeId,
      agentType: proto.agentType,
      worktree: proto.worktree,
      branch: proto.branch,
      status: proto.status,
      startedAt: Number(proto.startedAt),
      currentPrompt: proto.currentPrompt,
      workspaceId: proto.workspaceId,
      sessionTitle: proto.sessionTitle,
      toolUseCount: proto.toolUseCount,
      availableModels: proto.availableModels.map((m) => ({
        id: m.id,
        displayName: m.displayName,
      })),
      currentModel: proto.currentModel,
      state: proto.state,
      stage: proto.stage,
      errorCode: proto.errorCode,
      errorMessage: proto.errorMessage,
      failedStage: proto.failedStage,
      availableCommands: proto.availableCommands.map((c) => ({
        name: c.name,
        description: c.description,
        inputHint: c.inputHint,
      })),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/runtime-info.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Verify no regression**

Run: `pnpm --filter @teamclaw/expo test`
Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: 216 pass (213 + 3 new), only pre-existing AuthScreen tsc error.

- [ ] **Step 6: Commit**

```bash
git add apps/expo/src/lib/teamclaw/runtime-info.ts apps/expo/src/test/runtime-info.test.ts
git commit -m "feat(expo): real decodeRuntimeInfo via fromBinary(RuntimeInfoSchema)"
```

---

# Task B — AgentConfigSheet

## Task B.1: Sheet component

**Files:**
- Create: `apps/expo/src/features/sessions/components/AgentConfigSheet.tsx`
- Create: `apps/expo/src/test/agent-config-sheet.test.tsx`

- [ ] **Step 1: Read existing UI conventions**

Read `apps/expo/src/features/sessions/screens/ZeroAgentReminderSheet.tsx` for the style baseline (formSheet-friendly layout, `colors`/`spacing` tokens). Read `apps/expo/src/ui/atoms/SegmentedFilter.tsx` if it exists — use it for the agent type picker, else build inline.

- [ ] **Step 2: Write failing tests**

```tsx
// apps/expo/src/test/agent-config-sheet.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react-native";

import { AgentConfigSheet } from "../features/sessions/components/AgentConfigSheet";

const workspaces = [
  { id: "w1", path: "/repo-a" },
  { id: "w2", path: "/repo-b" },
];

describe("AgentConfigSheet", () => {
  it("renders each workspace as a selectable row", () => {
    const { getByText } = render(
      <AgentConfigSheet
        actorDisplayName="mini"
        workspaces={workspaces}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getByText("/repo-a")).toBeTruthy();
    expect(getByText("/repo-b")).toBeTruthy();
  });

  it("renders three agent type options", () => {
    const { getByText } = render(
      <AgentConfigSheet
        actorDisplayName="mini"
        workspaces={workspaces}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getByText("Claude")).toBeTruthy();
    expect(getByText("OpenCode")).toBeTruthy();
    expect(getByText("Codex")).toBeTruthy();
  });

  it("calls onConfirm with the selected workspace + agent type when Add is pressed", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <AgentConfigSheet
        actorDisplayName="mini"
        workspaces={workspaces}
        defaultType="opencode"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.press(getByText("/repo-b"));
    fireEvent.press(getByText("Add"));
    expect(onConfirm).toHaveBeenCalledWith({
      workspaceId: "w2",
      agentType: "opencode",
    });
  });

  it("disables Add when no workspace is selected", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <AgentConfigSheet
        actorDisplayName="mini"
        workspaces={[]}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.press(getByText("Add"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    const { getByText } = render(
      <AgentConfigSheet
        actorDisplayName="mini"
        workspaces={workspaces}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.press(getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

If `@testing-library/react-native` isn't installed in this project, you have two options:
1. Use a lightweight snapshot + invocation test pattern instead — call the component as a function and inspect its return shape with shallow assertions. Match whatever pattern the existing Expo tests use. CHECK first.
2. Add the package as a dev dependency.

CHECK the existing tests in `apps/expo/src/test/` — see how they test React components. If none do, the component tests can be a smoke shape only (does it render without crashing) + the logic (selection state, callback wiring) tested as plain TypeScript functions extracted from the component.

**If RTL is not available and the project doesn't test RN components in vitest currently**, simplify: extract the selection-state logic into a pure helper (`computeNextSelection(workspaceId, agentType)`) and unit-test that. The component itself becomes a thin renderer that the manual smoke verifies.

- [ ] **Step 3: Run — expect failure**

Run from repo root: `pnpm --filter @teamclaw/expo test src/test/agent-config-sheet.test.tsx`
Expected: fail (file doesn't exist) or fail with RTL not installed.

If RTL is not present, replace the test plan in Step 2 with a pure-function test for the selection helper (see fallback above), and adapt the component to use that helper.

- [ ] **Step 4: Implement component**

```tsx
// apps/expo/src/features/sessions/components/AgentConfigSheet.tsx
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors, radii, spacing, typography } from "../../../ui/theme";

export type AgentType = "claude" | "opencode" | "codex";

export type AgentConfigSheetProps = {
  actorDisplayName: string;
  workspaces: { id: string; path: string }[];
  defaultType?: AgentType;
  onConfirm: (selection: { workspaceId: string; agentType: AgentType }) => void;
  onCancel: () => void;
};

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  opencode: "OpenCode",
  codex: "Codex",
};

const AGENT_TYPE_ORDER: AgentType[] = ["claude", "opencode", "codex"];

export function AgentConfigSheet({
  actorDisplayName,
  workspaces,
  defaultType = "claude",
  onConfirm,
  onCancel,
}: AgentConfigSheetProps) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    workspaces[0]?.id ?? "",
  );
  const [selectedType, setSelectedType] = useState<AgentType>(defaultType);

  const canConfirm = selectedWorkspaceId !== "";

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onCancel}>
          <Text style={styles.toolbarMuted}>Cancel</Text>
        </Pressable>
        <Text numberOfLines={1} style={styles.toolbarTitle}>
          Configure {actorDisplayName}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={!canConfirm}
          hitSlop={8}
          onPress={() => {
            if (!canConfirm) return;
            onConfirm({ workspaceId: selectedWorkspaceId, agentType: selectedType });
          }}
        >
          <Text style={[styles.toolbarPrimary, !canConfirm && styles.toolbarDisabled]}>
            Add
          </Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.sectionHeader}>WORKSPACE</Text>
        {workspaces.length === 0 ? (
          <Text style={styles.emptyHint}>No workspaces available.</Text>
        ) : (
          workspaces.map((ws) => {
            const selected = ws.id === selectedWorkspaceId;
            return (
              <Pressable
                accessibilityRole="button"
                key={ws.id}
                onPress={() => setSelectedWorkspaceId(ws.id)}
                style={({ pressed }) => [
                  styles.workspaceRow,
                  pressed ? styles.workspaceRowPressed : null,
                ]}
              >
                <Ionicons
                  color={selected ? colors.cinnabar : colors.slate}
                  name={selected ? "radio-button-on" : "radio-button-off"}
                  size={18}
                />
                <Text numberOfLines={1} style={styles.workspacePath}>
                  {ws.path}
                </Text>
              </Pressable>
            );
          })
        )}

        <Text style={[styles.sectionHeader, styles.sectionHeaderSpaced]}>
          AGENT TYPE
        </Text>
        <View style={styles.segmented}>
          {AGENT_TYPE_ORDER.map((type) => {
            const selected = type === selectedType;
            return (
              <Pressable
                accessibilityRole="button"
                key={type}
                onPress={() => setSelectedType(type)}
                style={({ pressed }) => [
                  styles.segment,
                  selected ? styles.segmentActive : null,
                  pressed ? styles.segmentPressed : null,
                ]}
              >
                <Text
                  style={[
                    styles.segmentLabel,
                    selected ? styles.segmentLabelActive : null,
                  ]}
                >
                  {AGENT_TYPE_LABELS[type]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  emptyHint: {
    color: colors.slate,
    paddingVertical: spacing.sm,
    ...typography.caption,
  },
  screen: {
    backgroundColor: colors.paper,
    flex: 1,
  },
  sectionHeader: {
    color: colors.slate,
    paddingHorizontal: spacing.xs,
    ...typography.monoMeta,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  sectionHeaderSpaced: {
    marginTop: spacing.lg,
  },
  segment: {
    alignItems: "center",
    flex: 1,
    paddingVertical: 10,
  },
  segmentActive: {
    backgroundColor: colors.paper,
  },
  segmentLabel: {
    color: colors.basalt,
    ...typography.body,
    fontWeight: "500",
  },
  segmentLabelActive: {
    color: colors.onyx,
    fontWeight: "700",
  },
  segmentPressed: {
    opacity: 0.85,
  },
  segmented: {
    backgroundColor: colors.mist,
    borderColor: colors.hairline,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    overflow: "hidden",
  },
  toolbar: {
    alignItems: "center",
    backgroundColor: colors.paper,
    borderBottomColor: colors.hairline,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  toolbarDisabled: {
    opacity: 0.4,
  },
  toolbarMuted: {
    color: colors.basalt,
    ...typography.body,
  },
  toolbarPrimary: {
    color: colors.cinnabar,
    fontWeight: "600",
    ...typography.body,
  },
  toolbarTitle: {
    color: colors.onyx,
    flex: 1,
    paddingHorizontal: spacing.sm,
    textAlign: "center",
    ...typography.body,
    fontWeight: "600",
  },
  workspacePath: {
    color: colors.onyx,
    flex: 1,
    ...typography.body,
  },
  workspaceRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: 10,
  },
  workspaceRowPressed: {
    opacity: 0.7,
  },
});
```

- [ ] **Step 5: Run tests**

If RTL was available and you wrote real component tests: `pnpm --filter @teamclaw/expo test src/test/agent-config-sheet.test.tsx` should pass.

If you went the pure-helper route: the helper test should pass.

If you went the smoke-only route: just verify the component imports cleanly via `pnpm --filter @teamclaw/expo exec tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add apps/expo/src/features/sessions/components/AgentConfigSheet.tsx apps/expo/src/test/agent-config-sheet.test.tsx
git commit -m "feat(expo): AgentConfigSheet (workspace + agent type picker)"
```

---

## Task B.2: Wire AgentConfigSheet into NewSessionScreen

**Files:**
- Modify: `apps/expo/src/features/sessions/screens/NewSessionScreen.tsx`

- [ ] **Step 1: Read NewSessionScreen**

Open `apps/expo/src/features/sessions/screens/NewSessionScreen.tsx` and find where the user can add an agent (or where the agent type currently gets implicitly assigned). The existing flow might already have an "Add agent" button that opens a different sheet — extend or replace that path with `AgentConfigSheet`.

If the current flow has no agent type selection at all (sessions get a default agent), the integration is to add a button (e.g. "Configure agent") that opens the sheet. The selection is then passed through to whatever creates the session.

- [ ] **Step 2: Wire it**

The minimum: import `AgentConfigSheet`, add a state variable `agentConfigSheetOpen`, render the sheet inside a `Modal` (or via expo-router route if that's the existing convention), and on confirm, stash the selection in screen state and use it when the session is created.

If the existing session creation API doesn't yet accept `agentType` as a parameter, your changes here are scoped to: open the sheet, capture the selection, log it. The downstream wiring to the daemon RPC is out of scope for this batch and can be a follow-up (the iOS code path likely sends the agent type via the team/session creation RPC, but Expo's session creation may not have that field plumbed yet).

DO NOT redesign the session-create RPC contract in this task. If you find the agent type can't be passed through, stop and note as a `DONE_WITH_CONCERNS` — the sheet still lands as a component for future use.

- [ ] **Step 3: Type-check + test**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Run: `pnpm --filter @teamclaw/expo test`
Expected: still 216+ pass.

- [ ] **Step 4: Commit**

```bash
git add apps/expo/src/features/sessions/screens/NewSessionScreen.tsx
git commit -m "feat(expo): wire AgentConfigSheet into NewSessionScreen"
```

---

# Task C — Dynamic slash commands

## Task C.1: Align SlashCommand shape + built-in fallback

**Files:**
- Modify: `apps/expo/src/features/sessions/components/slash-commands.ts`
- Modify: `apps/expo/src/test/slash-commands.test.ts`

- [ ] **Step 1: Read current shape**

`apps/expo/src/features/sessions/components/slash-commands.ts` exports a `SlashCommand` type with an `action: "insert" | "clear" | "compact"` enum. Replace with the iOS-aligned shape.

- [ ] **Step 2: Update slash-commands.ts**

```ts
// apps/expo/src/features/sessions/components/slash-commands.ts
export type SlashCommand = {
  name: string;
  description: string;
  inputHint: string;
};

/**
 * Universal fallback so the popup is usable before (or instead of)
 * the runtime emitting `AvailableCommandsUpdate`. Mirrors iOS
 * `SessionDetailViewModel.builtInSlashCommands`.
 */
export const BUILT_IN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "clear", description: "Clear conversation history", inputHint: "" },
  { name: "compact", description: "Compact the conversation", inputHint: "" },
  { name: "help", description: "Show available commands", inputHint: "" },
  { name: "model", description: "Switch the active model", inputHint: "" },
  { name: "cost", description: "Show session token cost", inputHint: "" },
];

export function slashPrefix(composerText: string): string | null {
  const first = composerText.charAt(0);
  if (first !== "/") return null;
  const rest = composerText.slice(1);
  if (!/^[a-zA-Z0-9_-]*$/.test(rest)) return null;
  return rest;
}

export function filterSlashCommands(
  commands: readonly SlashCommand[],
  prefix: string,
): SlashCommand[] {
  const needle = prefix.toLowerCase();
  return [...commands]
    .filter((cmd) => cmd.name.startsWith(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

Note: `SLASH_COMMANDS` (`ReadonlySet<SlashCommand>`) is removed. `filterSlashCommands` now takes a `readonly SlashCommand[]` instead. Update existing call sites.

- [ ] **Step 3: Adjust existing test**

Open `apps/expo/src/test/slash-commands.test.ts`. Update any imports from `SLASH_COMMANDS` to use `BUILT_IN_SLASH_COMMANDS`. Update tests that asserted on `action` field to drop those assertions.

- [ ] **Step 4: Adjust call sites**

Run `grep -rn "SLASH_COMMANDS\|action.*insert\|action.*clear\|action.*compact" apps/expo/src/` to find every place that referenced the old shape. Each call site that imported `SLASH_COMMANDS` needs to import `BUILT_IN_SLASH_COMMANDS`. Each call site that used `cmd.action` to branch behavior should now just always insert `/<name> ` (the iOS behavior).

- [ ] **Step 5: Type-check + test**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Run: `pnpm --filter @teamclaw/expo test`
Expected: still 216+ pass.

- [ ] **Step 6: Commit**

```bash
git add apps/expo/src/features/sessions/components/slash-commands.ts apps/expo/src/test/slash-commands.test.ts
# (plus any call sites you updated)
git commit -m "refactor(expo): align SlashCommand shape with iOS; built-in fallback set"
```

---

## Task C.2: Resolver

**Files:**
- Create: `apps/expo/src/features/sessions/components/runtime-commands.ts`
- Create: `apps/expo/src/test/runtime-commands.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/expo/src/test/runtime-commands.test.ts
import { describe, expect, it } from "vitest";

import { resolveSlashCommands } from "../features/sessions/components/runtime-commands";
import { BUILT_IN_SLASH_COMMANDS } from "../features/sessions/components/slash-commands";
import type { RuntimeInfo } from "../features/actors/connected-agent-types";

function baseRuntimeInfo(over: Partial<RuntimeInfo>): RuntimeInfo {
  return {
    runtimeId: "r", agentType: 1, worktree: "", branch: "",
    status: 0, startedAt: 0, currentPrompt: "", workspaceId: "",
    sessionTitle: "", toolUseCount: 0, availableModels: [],
    currentModel: "", state: 0, stage: "", errorCode: "",
    errorMessage: "", failedStage: "", availableCommands: [],
    ...over,
  };
}

describe("resolveSlashCommands", () => {
  it("returns built-in when no runtimes have announced", () => {
    const out = resolveSlashCommands([], BUILT_IN_SLASH_COMMANDS);
    expect(out).toEqual([...BUILT_IN_SLASH_COMMANDS]);
  });

  it("returns built-in when runtimes report empty arrays", () => {
    const out = resolveSlashCommands(
      [baseRuntimeInfo({ availableCommands: [] })],
      BUILT_IN_SLASH_COMMANDS,
    );
    expect(out).toEqual([...BUILT_IN_SLASH_COMMANDS]);
  });

  it("returns runtime commands when at least one has announced", () => {
    const out = resolveSlashCommands(
      [baseRuntimeInfo({
        availableCommands: [
          { name: "custom", description: "Do thing", inputHint: "" },
        ],
      })],
      BUILT_IN_SLASH_COMMANDS,
    );
    expect(out).toEqual([
      { name: "custom", description: "Do thing", inputHint: "" },
    ]);
  });

  it("first runtime wins on duplicate names across runtimes", () => {
    const out = resolveSlashCommands(
      [
        baseRuntimeInfo({
          availableCommands: [
            { name: "clear", description: "From rt1", inputHint: "" },
          ],
        }),
        baseRuntimeInfo({
          availableCommands: [
            { name: "clear", description: "From rt2", inputHint: "" },
            { name: "extra", description: "Only rt2", inputHint: "" },
          ],
        }),
      ],
      BUILT_IN_SLASH_COMMANDS,
    );
    expect(out).toEqual([
      { name: "clear", description: "From rt1", inputHint: "" },
      { name: "extra", description: "Only rt2", inputHint: "" },
    ]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @teamclaw/expo test src/test/runtime-commands.test.ts`

- [ ] **Step 3: Implement**

```ts
// apps/expo/src/features/sessions/components/runtime-commands.ts
import type { RuntimeInfo } from "../../actors/connected-agent-types";
import type { SlashCommand } from "./slash-commands";

/**
 * Returns the slash commands the composer should surface for a session.
 * Mirrors iOS `SessionDetailViewModel.availableCommands`:
 *   - if any runtime in the session has announced commands, return the
 *     union (first occurrence wins on duplicate names)
 *   - otherwise return the built-in fallback set
 */
export function resolveSlashCommands(
  runtimeInfos: RuntimeInfo[],
  builtIn: readonly SlashCommand[],
): SlashCommand[] {
  const seen = new Set<string>();
  const dynamic: SlashCommand[] = [];
  for (const runtime of runtimeInfos) {
    for (const cmd of runtime.availableCommands) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      dynamic.push({
        name: cmd.name,
        description: cmd.description,
        inputHint: cmd.inputHint,
      });
    }
  }
  return dynamic.length > 0 ? dynamic : [...builtIn];
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @teamclaw/expo test src/test/runtime-commands.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/expo/src/features/sessions/components/runtime-commands.ts apps/expo/src/test/runtime-commands.test.ts
git commit -m "feat(expo): resolveSlashCommands resolver (dynamic + built-in fallback)"
```

---

## Task C.3: Expose ConnectedAgentsStore via context hook

**Files:**
- Modify: `apps/expo/app/_layout.tsx`

- [ ] **Step 1: Find existing context export**

`_layout.tsx` already exports `TeamMqttContext` + `useTeamMqtt()` (from Task D.7 of Batch 2). Mirror that pattern for `ConnectedAgentsStore`.

- [ ] **Step 2: Add a context + hook**

In `_layout.tsx`, add:

```ts
import type { ConnectedAgentsStore } from "../src/features/actors/connected-agents-store";

export const ConnectedAgentsContext = createContext<ConnectedAgentsStore | null>(null);
export function useConnectedAgentsStore() {
  return useContext(ConnectedAgentsContext);
}
```

Add a state variable mirroring the ref (same pattern as teamMqtt):

```ts
const [connectedAgentsStore, setConnectedAgentsStore] = useState<ConnectedAgentsStore | null>(null);
```

After `storeRef.current = store; await store.reload();`, set the state:
```ts
setConnectedAgentsStore(store);
```

In cleanup, set to null:
```ts
setConnectedAgentsStore(null);
```

Wrap children with the new provider:
```tsx
<TeamMqttContext.Provider value={teamMqtt}>
  <ConnectedAgentsContext.Provider value={connectedAgentsStore}>
    {children}
  </ConnectedAgentsContext.Provider>
</TeamMqttContext.Provider>
```

- [ ] **Step 3: Type-check + test**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Run: `pnpm --filter @teamclaw/expo test`
Expected: still 220+ pass (216 + 4 from C.2).

- [ ] **Step 4: Commit**

```bash
git add apps/expo/app/_layout.tsx
git commit -m "feat(expo): expose ConnectedAgentsStore via React context hook"
```

---

## Task C.4: Wire dynamic slash commands into composer

**Files:**
- Modify: `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx`

- [ ] **Step 1: Read the route file**

Find where the session's slash commands are currently surfaced. Look for `BUILT_IN_SLASH_COMMANDS`, `filterSlashCommands`, or where `SessionComposerShell` (or whatever the composer component is) receives its commands prop.

- [ ] **Step 2: Subscribe to ConnectedAgentsStore in the route**

Add inside the route component:

```ts
import { useConnectedAgentsStore } from "../../../_layout";
import { useSyncExternalStore } from "react";
import { resolveSlashCommands } from "../../../../src/features/sessions/components/runtime-commands";
import { BUILT_IN_SLASH_COMMANDS } from "../../../../src/features/sessions/components/slash-commands";
import type { RuntimeInfo } from "../../../../src/features/actors/connected-agent-types";

// inside component:
const connectedAgentsStore = useConnectedAgentsStore();
const emptyState = useMemo(() => ({
  agents: [],
  runtimeInfoByAgentId: new Map() as ReadonlyMap<string, RuntimeInfo>,
  isLoading: false,
  errorMessage: null,
}), []);
const agentsState = useSyncExternalStore(
  (listener) => connectedAgentsStore?.subscribe(listener) ?? (() => {}),
  () => connectedAgentsStore?.getState() ?? emptyState,
  () => connectedAgentsStore?.getState() ?? emptyState,
);

const sessionRuntimeInfos = useMemo(() => {
  const session = detailState.session;
  if (!session) return [];
  return session.participantActorIds
    .map((id) => agentsState.runtimeInfoByAgentId.get(id))
    .filter((r): r is RuntimeInfo => r != null);
}, [detailState.session, agentsState.runtimeInfoByAgentId]);

const dynamicSlashCommands = useMemo(
  () => resolveSlashCommands(sessionRuntimeInfos, BUILT_IN_SLASH_COMMANDS),
  [sessionRuntimeInfos],
);
```

- [ ] **Step 3: Pass commands into composer**

Find where the composer is rendered (likely `<SessionComposerShell ... />` or similar). Pass `slashCommands={dynamicSlashCommands}` as a new prop. If the composer currently imports `BUILT_IN_SLASH_COMMANDS` or `filterSlashCommands(SLASH_COMMANDS, ...)` internally, refactor it to take the commands as a prop.

- [ ] **Step 4: Update composer to accept commands prop**

In `SessionComposerShell.tsx` (or whichever file owns the popup):

```ts
type Props = {
  // … existing props
  slashCommands?: readonly SlashCommand[];
};
```

Default the prop to `BUILT_IN_SLASH_COMMANDS` if not provided so other call sites (if any) don't break. Use the prop in the `filterSlashCommands(slashCommands ?? BUILT_IN_SLASH_COMMANDS, prefix)` call.

- [ ] **Step 5: Type-check + test**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Run: `pnpm --filter @teamclaw/expo test`
Expected: still 220+ pass.

- [ ] **Step 6: Commit**

```bash
git add apps/expo/app/\(app\)/\(tabs\)/sessions/\[sessionId\].tsx \
        apps/expo/src/features/sessions/components/SessionComposerShell.tsx
git commit -m "feat(expo): composer reads dynamic slash commands from runtime info"
```

---

# Final Pass

## Task FINAL.1: Run full suite

- [ ] **Step 1: Tests**

Run: `pnpm --filter @teamclaw/expo test`
Expected: all tests pass — including 3 from runtime-info.test.ts, 4 from runtime-commands.test.ts, any agent-config-sheet tests.

- [ ] **Step 2: TypeScript**

Run: `pnpm --filter @teamclaw/expo exec tsc --noEmit`
Expected: only pre-existing `AuthScreen.tsx` `socialColumn` error.

- [ ] **Step 3: Branch clean**

Run: `git status`
Expected: clean working tree.

---

## Self-Review

**Spec coverage:**
- §3 decodeRuntimeInfo — Tasks A.1, A.2.
- §4 AgentConfigSheet — Tasks B.1, B.2.
- §5 Dynamic slash commands — Tasks C.1–C.4.

**Placeholder scan:**
- One acknowledged-soft-spot: AgentConfigSheet workspace list is stubbed with `[{ id: "default", path: "/" }]` if no workspace API exists. This is documented in the spec.

**Type consistency:**
- `RuntimeInfo` is consistent across Tasks A.1, A.2, C.2, C.4.
- `SlashCommand` matches iOS's shape (`{ name, description, inputHint }`) consistently across C.1, C.2, C.4.
- `AgentType = "claude" | "opencode" | "codex"` used only in B.1's component; not threaded into proto wire yet (call-site stub).
