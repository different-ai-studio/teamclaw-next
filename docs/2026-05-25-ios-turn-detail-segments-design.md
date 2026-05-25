# iOS Turn Detail — Interleaved Output Segments

**Date:** 2026-05-25
**Status:** Design approved, pending implementation plan
**Scope:** iOS only. No daemon, proto, or Supabase schema changes.

## Problem

The iOS message detail screen for a single assistant turn currently renders
"all tool calls first, then one big block of final output text" — see the
screenshots in the originating discussion. The desired layout is Claude
Code / Codex style: assistant text segments and tool calls interleaved in
the order they actually occurred during the turn.

### Root cause

The daemon and the on-disk envelope log already contain the full interleaved
event stream:

- `apps/daemon/src/runtime/turn_aggregator.rs:66-69` — when a `ToolUse` event
  arrives, the daemon flushes any pending reply buffer first, then emits the
  tool. So "tool interrupts reply" is an established product-level boundary
  on the daemon side.
- `apps/daemon/src/history/store.rs:115-149` — `read_turn(agent_id, turn_id)`
  returns every `Thinking / ToolCall / Output / ToolResult / StatusChange`
  envelope for a turn, in `sequence` order. Each `Output` envelope carries
  `isComplete` and is a streaming chunk; multiple chunks per segment.

The iOS reducer at
`apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/ChatTimelineReducer.swift`
flattens this stream by deduping on
`(bucket, turnID, "output", isComplete)` and merging partial chunks into a
single entry per turn. As a result:

- One `output` entry per turn, whose `text` is the *concatenation of all
  reply chunks across the entire turn*, regardless of how many tool calls
  the turn went through.
- That entry's `sequence` is the last chunk's sequence (because
  `isComplete=true` arrives at end-of-turn), placing it after every
  `tool_use` entry in the feed.
- Rendering therefore degenerates to "tool, tool, tool, final output."

The "tool interrupts reply" boundary that exists on the daemon side is **not
mirrored on the iOS side**.

## Goal

Restore segment boundaries inside the iOS reducer so the turn detail view
can render `output_segment_A → tool_A (+ result) → output_segment_B →
tool_B (+ result) → output_segment_C` in true chronological order, matching
the daemon's flush semantics.

Non-goals:

- Persisting segmented replies to Supabase. Supabase's `AgentReply` row
  remains the merged whole-turn text.
- Restoring segmentation for historical turns whose envelope log is gone.
  Such turns render as a single trailing segment (current behavior).
- Changing the main session feed's overall layout. Only the per-turn
  `finalEvent` selection rule shifts (see §3.3).

## Design

### 3.1 Data model

`TimelineEntry` (`apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/TimelineState.swift`)
and `AgentEvent` (`apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/AgentEvent.swift`):

- Add `resultSummary: String?`. Populated on `tool_use` rows when the
  matching `ToolResult` envelope arrives. `success` (already exists)
  plus `resultSummary` together represent the embedded tool result. No
  standalone `tool_result` entry is produced on the reducer path; the
  defensive `tool_result` branch for out-of-order arrivals stays as is.
- `isComplete` on `output` rows narrows from "the whole turn has ended"
  to "this segment has ended." For non-output rows the field keeps its
  existing semantics (tool_use complete = result arrived; permission
  complete = resolved; etc.).

`TimelineState` (same file) gets one new scratch field:

- `openSegmentByTurn: [String: UInt64]` — keyed by `"\(bucket)|\(turnID)"`,
  value is the `sequence` of the segment's first `Output` chunk (the
  segment id). Cleared per-key when a `ToolUse` arrives in that turn or
  the turn flips to Idle.

`TimelineSwiftDataSync` copies `resultSummary` between `TimelineEntry`
and `AgentEvent`. No new event types, no new entities, no Supabase
schema change.

**Production data flow** (verified): `SessionDetailViewModel.handleAcpEvent`
→ `applyTimelineInput(.acp(...))` → `ChatTimelineReducer.applyAcp` writes
`timelineState.entries` → `TimelineSwiftDataSync.sync(state:into:)`
projects entries to the SwiftData `events` array → `recomputeGroups`
builds `feedItems` via `FeedItem.buildFeedItems(events)` →
`StreamingDetailView` iterates `snapshot.events` (derived from the
selected `FeedItem`) → `EventFeedView` / `EventBubbleView` renders. No
view code reads the reducer state directly; everything flows through
the SwiftData projection. Reducer changes are visible to the view
without further wiring.

### 3.2 Reducer — `ChatTimelineReducer`

`applyAcp` is reworked around segment boundaries keyed by
`state.openSegmentByTurn["\(bucket)|\(turnID ?? "")"]`. The existing
"primary turn-id dedupe" block at the top of `applyAcp`
(`ChatTimelineReducer.swift:38-59`) is replaced by the new segment-aware
matcher (see helper change below).

Per incoming envelope kind:

| Envelope | Action |
|---|---|
| `Output(partial)` (`!o.isComplete`) | Compose key `k = "\(bucket)|\(turnID ?? "")"`. If `state.openSegmentByTurn[k] == nil`: open a new segment — set `segmentSeq = envelopeSequence`, write `openSegmentByTurn[k] = segmentSeq`, append a new `output` entry with `sequence = segmentSeq`, `isComplete = false`, `text = o.text`, `turnID`, `model`. Else: locate the entry via `findOutputSegmentEntry(bucket, turnID, segmentSeq: openSegmentByTurn[k]!)` and append `o.text` to its `text`. Always update `streamingTextByAgent[bucket] += o.text`, `streamingAgentSet.insert(bucket)`, `streamingModelByAgent[bucket] = acpEvent.model` (same as today). |
| `Output(isComplete=true)` | Run the open/append logic from the partial row first (with the complete chunk's text). Then mark the located entry's `isComplete = true`, clear `openSegmentByTurn[k]`. Update `streamingAgentSet.remove(bucket)`, `streamingTextByAgent[bucket] = nil`, `streamingModelByAgent[bucket] = nil`. |
| `ToolUse` | Compose `k`. If `openSegmentByTurn[k] != nil`, locate the matching output entry, set `isComplete = true`, clear `openSegmentByTurn[k]`. Then upsert a `tool_use` entry by `(bucket, toolID)` — existing branch at `ChatTimelineReducer.swift:136-157` stays. |
| `ToolResult` | Locate the `tool_use` entry with `toolID == tr.toolID` (existing branch, line 159-175). Set `success = tr.success`, `resultSummary = tr.summary`, `isComplete = true`. The defensive standalone-`tool_result` append for the no-match case (line 163-175) stays. |
| `Thinking` | Existing handling unchanged. Thinking does **not** open or close output segments — a reply can resume after a thinking block without forcing a new segment (matches daemon: thinking and reply share buffers, only `ToolUse` flushes). |
| `StatusChange Active→Idle` | Walk `openSegmentByTurn` for every key prefixed `"\(bucket)|"`: locate the matching output entry, set `isComplete = true`, remove the key. Existing branch at `ChatTimelineReducer.swift:222-245` that synthesizes a fallback `output` entry from `streamingTextByAgent[bucket]` is removed — the openSegmentByTurn flush always finds the entry it needs (since open segment ⇔ non-empty streaming buffer). The tool_use closing loop at lines 239-244 stays. |

Dedupe / lookup change: the existing `outputCompleteIndex(for:turnID:)`
helper at `ChatTimelineReducer.swift:553-571` is replaced by
`findOutputSegmentEntry(bucket:turnID:segmentSeq:)` that matches
`(bucket, turnID, sequence == segmentSeq)`. The top-of-function turn-id
dedupe block at lines 38-59 is removed: replays of the same envelope
now land on the same segment entry by `(bucket, turnID, sequence)` and
are idempotent without a special-cased early return. Non-output event
types (`tool_use`, `thinking`, etc.) keep their existing per-type
dedupe.

The history path (`applyHistory`, line 296+) currently runs a
"same-turn merge" at lines 421-454 that concatenates multiple Supabase
`AgentReply` rows into one bubble when they share `turnID`. This branch
**stays** — `applyHistory` is fed from Supabase rows, which contain the
whole reply with no segment metadata; segmentation only applies to the
`applyAcp` path that processes daemon envelopes.

### 3.3 Feed `finalEvent` selection

`FeedItem.completedTurn(finalEvent:runtimeEvents:)` — `finalEvent` is now
chosen as: the last entry in `runtimeEvents` with `eventType == "output"`
by `sequence`. Falls back to the last non-empty-text entry of any type if
the turn contains no output (pure-tool turn). `activeStream` is unchanged.

`SessionDetailView.activeStreamLastLine` — currently reads the latest
streaming buffer; it should read the currently open segment's entry text,
last line. If `openSegmentId == nil` (segment was just closed by a tool
and no new chunk has arrived), fall back to the most recent closed
`output` entry's last line. Behaviorally close to current.

### 3.4 Detail view rendering

`StreamingDetailView` and `EventFeedView` keep their existing inputs
(`runtimeEvents: [AgentEvent]` + optional `finalEvent`). No new
`TurnDetailItem` type is introduced — the reducer's segmented entries are
already the right shape.

`EventBubbleView`:

- `tool_use` case: render the tool card as today, plus an embedded
  result region driven by `event.resultSummary` and `event.success`.
  Collapsed by default with a success/failure indicator; tap to expand
  the summary text. If `event.isComplete == false` (no matching
  ToolResult yet), show a "running…" placeholder.
- `tool_result` case: kept for the defensive out-of-order arrival
  branch in `ChatTimelineReducer.swift:163-175`; renders as today.
- All other cases unchanged.

### 3.5 Historical compatibility

Turns whose envelope log is no longer available (older Supabase-only data,
or daemon history pruned) come in as a single complete `Output` with no
prior partials. The reducer's "complete-only" path produces a single
segment with `segmentId = envelope.sequence`, which renders as one trailing
text block — visually identical to today. No backfill, no fallback flags.

### 3.6 Testing

Reducer unit tests in
`apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift`:

1. **Single segment, no tool**: 3 partial chunks → idle. Expect 1 output
   entry, text fully merged, `isComplete = true`.
2. **Tool interrupts reply**: `Output(A) → Output(B) → ToolUse → ToolResult
   → Output(C) → idle`. Expect entries in `sequence` order: output("AB",
   complete), tool_use (`success` + `resultSummary` populated, `isComplete`
   true), output("C", complete).
3. **Two consecutive tools, no intervening text**: `Output(A) → Tool₁ →
   Result₁ → Tool₂ → Result₂ → Output(B) → idle`. Expect output("A"),
   tool₁, tool₂, output("B"). No phantom empty output entry between the
   tools.
4. **Live + history overlap idempotence**: feed an envelope sequence
   through `live append`, then replay the same sequence through
   `requestTurnHistory`. Expect identical `entries` list (no duplicates,
   no merges across segments).
5. **Single-shot complete (legacy path)**: just one
   `Output(isComplete=true)` arrives for a turn. Expect 1 output entry,
   segment opened and closed in one step.
6. **Out-of-order chunk delivery**: partials arrive `seq=5, 3, 4`. Expect
   they all land on the same segment (whichever has the lowest sequence
   id) and are concatenated in `sequence` order in the rendered text.
7. **Thinking does not split segment**: `Output(A) → Thinking → Output(B)
   → idle`. Expect 1 output entry "AB" (thinking is a sibling, not a
   boundary).
8. **ToolResult before ToolUse (defensive)**: ToolResult arrives for an
   unknown tool_id. Expect drop, no crash, no orphan entry.

Tool-result-embedded rendering: extend
`apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/ToolDisplayTests.swift`
with a case that asserts the tool card renders both name and result
summary when `event.resultSummary` and `event.success` are set.

SwiftUI snapshot tests for `EventFeedView` / `StreamingDetailView` are
intentionally skipped — low ROI on iOS 26 for this kind of structural
change.

## Risks and edge cases

- **`SessionDetailView.activeStreamLastLine`** currently feeds off
  `streamingTextByAgent[bucket]`; behavior is preserved because that
  buffer is updated identically (per-bucket rolling concatenation).
- **Main feed visual regression**: feed summary now shows the *last*
  reply segment instead of the whole concatenated reply. For turns that
  end with tool-only activity and no trailing text, the fallback in
  `FeedItem.completedTurn.finalEvent` picks the last non-empty entry.
  Watch feed during development; revisit in a follow-up if the
  trailing-segment summary looks too truncated.
- **Dedupe pruning**: `pruneDuplicateRuntimeEvents`
  (`SessionDetailViewModel.swift:286`) currently expects the old
  per-turn-single-output invariant. Audit the prune logic — it must
  preserve multi-segment same-turn entries (distinct `sequence` per
  segment).
- **`TimelineSwiftDataSync` field coverage**: the sync helper must
  project `resultSummary` between `TimelineEntry` and `AgentEvent`.
- **Reducer state size**: `openSegmentByTurn` is one `UInt64` per active
  turn, cleared on Idle. Negligible.

## Out of scope

- Daemon emitting segmented `AgentReply` rows to Supabase. Could be a
  future cleanup (parallels "schema-level segmented trace"), not required
  now.
- Android parity. Tracked separately under the iOS→Android parity roadmap.
- Web/desktop `ChatMessage.tsx` already has the `parts[]` field but isn't
  interleaving either; out of scope.

## Acceptance

1. `Output A → ToolUse → ToolResult → Output B` turn in the iOS detail
   view renders as four visual blocks in that order.
2. Multi-tool turns preserve intermediate assistant text segments.
3. A completed turn loaded via `requestTurnHistory` and the same turn
   streamed live produce the same detail-view ordering.
4. Main feed still shows one assistant bubble per turn (no runtime detail
   leakage), summary text from the trailing segment.
