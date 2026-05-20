# Expo / iOS Parity Batch 3: RuntimeInfo decode · AgentConfigSheet · Dynamic Slash Commands

**Status:** Draft (awaiting user review)
**Date:** 2026-05-20
**Branch:** `fix/expo` (worktree `.worktrees/fix-expo`)
**Predecessor specs:** [2026-05-20-expo-ios-parity-batch-2-design.md](2026-05-20-expo-ios-parity-batch-2-design.md)

## 1. Goal

Land three iOS-parity features that build directly on the Batch 2 foundation:

1. **`decodeRuntimeInfo` proto wiring** — replace the `null`-returning placeholder with a real `fromBinary(RuntimeInfoSchema, payload)` decoder so the runtime/+/state subscription stops being a no-op.
2. **AgentConfigSheet** — workspace + agent type (claude/opencode/codex) picker used when creating a session or adding an agent. 1:1 port of `apps/ios/Packages/AMUXUI/Sources/AMUXUI/SessionList/AgentConfigSheet.swift`.
3. **Dynamic slash commands** — surface `RuntimeInfo.availableCommands` to the composer's slash popup. Fall back to iOS's built-in set (`clear`/`compact`/`help`/`model`/`cost`) when the runtime hasn't announced anything.

Out of scope (deferred): per-session model picker UI, Apple/Google sign-in, push notification receiving.

## 2. Shape of the work

These three features share data flow:

```
MQTT amux/.../runtime/+/state  (RuntimeInfo proto)
  → decodeRuntimeInfo()                              [Task A]
  → runtime-state-subscriber → onRuntimeInfo callback
  → ConnectedAgentsStore.handleRuntimeInfo()
       └─ runtimeInfoByAgentId Map<agentId, RuntimeInfo>
  → useDynamicSlashCommandsForSession(sessionId)     [Task C]
  → SlashCommandsPopup                                [Task C]

NewSessionScreen / AddAgent flow
  → AgentConfigSheet (workspace + type picker)       [Task B]
```

## 3. Task A — Replace `decodeRuntimeInfo` placeholder

### 3.1 Files

| File | Change |
|---|---|
| `apps/expo/src/features/actors/connected-agent-types.ts` | EDIT — extend `RuntimeInfo` shape with `availableCommands`, `worktree`, `branch`, `state` |
| `apps/expo/src/lib/teamclaw/runtime-info.ts` | REWRITE — real decoder via `fromBinary(RuntimeInfoSchema, payload)` + proto→app mapping |
| `apps/expo/src/test/runtime-info.test.ts` | NEW — tests decode + mapping |

### 3.2 Updated `RuntimeInfo` shape

```ts
// apps/expo/src/features/actors/connected-agent-types.ts
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
  startedAt: number;            // epoch seconds (bigint → number)
  currentPrompt: string;
  workspaceId: string;
  sessionTitle: string;
  toolUseCount: number;
  availableModels: { id: string; displayName: string }[];
  currentModel: string;
  state: number;                // amux.RuntimeLifecycle
  stage: string;
  errorCode: string;
  errorMessage: string;
  failedStage: string;
  availableCommands: RuntimeAvailableCommand[];
};
```

### 3.3 Decoder

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

### 3.4 Tests

- Roundtrip: `create(RuntimeInfoSchema, {...}) → toBinary → decodeRuntimeInfo` matches input
- Malformed payload (random bytes): returns `null` not throw
- Empty `availableCommands`: returns `[]`, not undefined

### 3.5 Consumers

`ConnectedAgentsStore.handleRuntimeInfo` is already wired (Task D.5 in Batch 2). Once the decoder returns real values, the store's `runtimeInfoByAgentId` map will populate live. No store changes needed.

## 4. Task B — AgentConfigSheet

### 4.1 Files

| File | Change |
|---|---|
| `apps/expo/src/features/sessions/components/AgentConfigSheet.tsx` | NEW — sheet component |
| `apps/expo/src/features/sessions/screens/NewSessionScreen.tsx` | EDIT — open AgentConfigSheet when adding an agent |
| `apps/expo/src/test/agent-config-sheet.test.tsx` | NEW — interaction smoke test |

### 4.2 Component shape

Mirrors `apps/ios/Packages/AMUXUI/Sources/AMUXUI/SessionList/AgentConfigSheet.swift` 1:1:

```tsx
export type AgentConfigSheetProps = {
  actorDisplayName: string;
  workspaces: { id: string; path: string }[];
  defaultType?: AgentType;       // "claude" | "opencode" | "codex"
  onConfirm: (selection: { workspaceId: string; agentType: AgentType }) => void;
  onCancel: () => void;
};

export type AgentType = "claude" | "opencode" | "codex";
```

### 4.3 Layout

```
┌────────────────────────────────────────────┐
│  Cancel    Configure {actorName}    Add    │
├────────────────────────────────────────────┤
│                                             │
│  WORKSPACE                                  │
│  ○ /Volumes/openbeta/workspace/foo          │
│  ● /Volumes/openbeta/workspace/teamclaw-v2  │
│  ○ /Volumes/openbeta/workspace/bar          │
│                                             │
│  AGENT TYPE                                 │
│  [ Claude ][ OpenCode ][ Codex ]            │
│                                             │
└────────────────────────────────────────────┘
```

- Workspace: radio-style list (inline picker on iOS); on RN use `Pressable` rows with a check glyph.
- Agent type: segmented control. Use the existing `SegmentedFilter` atom if compatible, else inline custom.
- `Add` button disabled when `workspaceId === ""`.
- Sheet presentation: `presentation: "formSheet"` matching the existing modal style in the Expo app.
- `presentationDetents([.medium])` equivalent: in RN this is just a half-height sheet — register the route with `presentation: "formSheet"` and let it sit at half-height by default.

### 4.4 Integration points

`AgentConfigSheet` opens in two flows:

1. **NewSessionScreen** — when the user picks "Add agent" before sending the first message, the sheet appears, user picks workspace + type, then the session is created with that agent type. Read available workspaces from a new `useWorkspaces(teamId)` hook (Supabase RPC if needed, or hardcoded list for now if backend isn't ready — defer to follow-up).
2. **AddAgent flow** (later) — adding an extra agent to an existing session. Not in scope for this batch but the sheet should support both call sites.

For this batch, only NewSessionScreen integration is required. The `useWorkspaces` lookup can return a stub `[{ id: "default", path: "/" }]` if no team workspace data is available — the sheet still renders and the picker degrades gracefully.

### 4.5 Tests

- Renders 3 segmented options (Claude/OpenCode/Codex)
- Renders one row per workspace
- Selecting a workspace updates `selectedWorkspaceId`
- "Add" disabled when no workspace selected
- "Cancel" calls onCancel; "Add" calls onConfirm with current selection

## 5. Task C — Dynamic slash commands

### 5.1 Files

| File | Change |
|---|---|
| `apps/expo/src/features/sessions/components/slash-commands.ts` | EDIT — split into static seed + helpers; remove the iOS-mismatched action enum |
| `apps/expo/src/features/sessions/components/runtime-commands.ts` | NEW — map `RuntimeAvailableCommand` → `SlashCommand`; resolveSlashCommands(dynamic, static) |
| `apps/expo/src/features/sessions/components/SessionComposerShell.tsx` *(or wherever the popup is rendered)* | EDIT — consume dynamic commands from a context/prop |
| `apps/expo/app/_layout.tsx` | EDIT — re-export `useConnectedAgents()` hook reading from `ConnectedAgentsStore` |
| `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx` | EDIT — pass dynamic commands into the composer |
| `apps/expo/src/test/runtime-commands.test.ts` | NEW — tests resolve precedence + dedup |
| `apps/expo/src/test/slash-commands.test.ts` | EDIT — adjust to new shape if breaks |

### 5.2 Static fallback

Replace the current static set with iOS's built-in set (the existing fallback that matters today is "agent hasn't reported anything yet"):

```ts
export const BUILT_IN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "clear", description: "Clear conversation history", inputHint: "" },
  { name: "compact", description: "Compact the conversation", inputHint: "" },
  { name: "help", description: "Show available commands", inputHint: "" },
  { name: "model", description: "Switch the active model", inputHint: "" },
  { name: "cost", description: "Show session token cost", inputHint: "" },
];
```

### 5.3 New `SlashCommand` shape

The current shape includes an `action: "insert" | "clear" | "compact"` enum that maps poorly to dynamic runtime-announced commands. iOS's `SlashCommand` is just `{ name, description, inputHint }` — same shape as `AcpAvailableCommand`. Align.

```ts
export type SlashCommand = {
  name: string;
  description: string;
  inputHint: string;
};
```

The composer's `onTap` handler always inserts `/<name> ` into the composer; runtime-side actions (clear, compact, etc.) are interpreted by the agent when received. No client-side action enum required.

### 5.4 Resolution

```ts
// apps/expo/src/features/sessions/components/runtime-commands.ts
import type { SlashCommand } from "./slash-commands";
import type { RuntimeInfo } from "../../actors/connected-agent-types";

export function resolveSlashCommands(
  runtimeInfos: RuntimeInfo[],
  builtIn: readonly SlashCommand[],
): SlashCommand[] {
  // 1. Union all agent-announced commands, dedup by name (first wins)
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
  // 2. iOS rule: if any agent has announced, use dynamic only.
  //    Otherwise fall back to built-in.
  return dynamic.length > 0 ? dynamic : [...builtIn];
}
```

### 5.5 Threading runtime info to the popup

The session route already has access to the `ConnectedAgentsStore` via the `useTeamMqtt`-adjacent context (or can subscribe directly). The simplest path:

1. Add a new context hook `useConnectedAgentsStore()` in `app/_layout.tsx`, mirroring `useTeamMqtt()`. It returns the `ConnectedAgentsStore` instance (or null if not ready).
2. In `[sessionId].tsx`, derive the runtime infos for agents in this session:
   ```ts
   const store = useConnectedAgentsStore();
   const storeState = useSyncExternalStore(
     store?.subscribe ?? (() => () => {}),
     store?.getState ?? (() => ({ agents: [], runtimeInfoByAgentId: new Map(), isLoading: false, errorMessage: null })),
   );
   const sessionAgentIds = useMemo(
     () => detailState.session?.participantActorIds ?? [],
     [detailState.session?.participantActorIds],
   );
   const sessionRuntimeInfos = useMemo(
     () => sessionAgentIds
       .map((id) => storeState.runtimeInfoByAgentId.get(id))
       .filter((r): r is RuntimeInfo => r != null),
     [sessionAgentIds, storeState.runtimeInfoByAgentId],
   );
   const slashCommands = useMemo(
     () => resolveSlashCommands(sessionRuntimeInfos, BUILT_IN_SLASH_COMMANDS),
     [sessionRuntimeInfos],
   );
   ```
3. Pass `slashCommands` to the composer (existing prop or new one), which threads to `SlashCommandsPopup`.

### 5.6 Tests

- `resolveSlashCommands([], builtIn)` → returns built-in
- `resolveSlashCommands([oneRuntime], [])` → returns runtime's commands
- `resolveSlashCommands([rt1, rt2], builtIn)` with overlapping `name` → first runtime wins for duplicates
- `resolveSlashCommands([{availableCommands: []}], builtIn)` → still returns built-in (empty announcements don't count as "announced")

## 6. Implementation order

1. **Task A (decodeRuntimeInfo)** — smallest change, unblocks runtime data flow. Verify by manually publishing a `RuntimeInfo` to MQTT and observing the store update.
2. **Task C (dynamic slash commands)** — depends on Task A's data. Replaces static behavior with dynamic + fallback.
3. **Task B (AgentConfigSheet)** — orthogonal UI. Lands last so it can be parallelized if needed.

## 7. Risks

| Risk | Mitigation |
|---|---|
| `@teamclaw/app/proto/amux_pb` not resolvable from Expo's tsconfig paths | Verify the package export at task start; if broken, add a tsconfig alias or path mapping before Task A |
| `RuntimeInfo` shape evolves on the daemon side | The decoder is field-by-field — adding fields is non-breaking; removing fields means the decoder defaults the absent ones to "" / 0 / [] which is forward-compatible |
| `useConnectedAgentsStore` triggers re-render storms when runtime info updates frequently | Use `useSyncExternalStore` to subscribe; reducer memoization (`useMemo`) on derived `sessionRuntimeInfos` prevents downstream churn |
| AgentConfigSheet workspaces list is unavailable in Expo | Stub with a single default workspace `{ id: "default", path: "/" }` until workspace API lands; the sheet still functions for new-session flow |
| Agents in the same session announce conflicting `availableCommands` | First-wins dedup is documented in the resolver — small ambiguity, matches iOS's "latest wins" intent closely enough |

## 8. Non-goals

- Model picker UI (separate batch; the underlying `availableModels` is already decoded, so this is a future incremental feature)
- AddAgentSheet (later) — AgentConfigSheet supports the API but the call site is only NewSessionScreen here
- Workspace discovery (uses stub until Supabase workspace API lands)
- Per-runtime active state (e.g. greying out commands for offline runtimes) — `availableCommands` from `runtimeInfoByAgentId` is best-effort

## 9. Acceptance

- `pnpm --filter @teamclaw/expo test` — 213 + new tests pass
- `pnpm --filter @teamclaw/expo exec tsc --noEmit` — only pre-existing `AuthScreen.tsx` error
- Manual smoke: publish a `RuntimeInfo` proto with non-empty `availableCommands` to `amux/{teamId}/device/{deviceId}/runtime/{runtimeId}/state` retained; open the session; `/` shows the runtime's commands
- Manual smoke: AgentConfigSheet renders in NewSessionScreen, can pick agent type, confirm fires `onConfirm` with the correct selection
