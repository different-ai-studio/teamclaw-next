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

`AgentEvent` (`apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/AgentEvent.swift`):

- `metadata` JSON gains a new optional key `tool_result` with shape
  `{ "success": bool, "summary": string }`, populated on `tool_use` events
  when their matching `ToolResult` envelope arrives. No standalone
  `tool_result` entry is produced.
- `isComplete` semantics narrows from "the whole turn has ended" to "this
  segment has ended." For non-output events the field is unused (kept
  `true` on emission for back-compat).

No new event types. No new entities.

### 3.2 Reducer — `ChatTimelineReducer`

New per-bucket-per-turn transient state: `openSegmentId: Int?` (the
`sequence` of the segment's first `Output` chunk, used as the segment's
stable id).

Reducer rules per incoming envelope kind:

| Envelope | Action |
|---|---|
| `Output(partial)` | If `openSegmentId == nil`: open a new segment, allocate `segmentId = envelope.sequence`, create an `output` entry with that `segmentId` and the chunk text. Else: append chunk text to the entry keyed by `(bucket, turnID, openSegmentId)`. |
| `Output(isComplete=true)` | Same append/open logic as partial. Then mark the entry `isComplete = true` and clear `openSegmentId`. (For old single-shot rows that come complete-only with no prior partials, this still produces a valid 1-chunk segment.) |
| `ToolUse` | If `openSegmentId != nil`, mark the corresponding entry `isComplete = true` and clear `openSegmentId`. Then create a `tool_use` entry with `metadata.tool_id, tool_name, description` as today. |
| `ToolResult` | Locate the `tool_use` entry with matching `(bucket, turnID, metadata.tool_id)`. Merge `{success, summary}` into its `metadata.tool_result`. No new entry. If no matching tool_use is found (out-of-order / missing tool_use), drop silently (acceptable for dev period). |
| `Thinking` | Existing handling unchanged. Thinking does **not** open or close output segments — a reply can resume after a thinking block without forcing a new segment (matches daemon: thinking and reply share buffers, only `ToolUse` flushes). |
| `StatusChange Active→Idle` | If `openSegmentId != nil`, mark its entry `isComplete = true` and clear. Tail-flush fallback. |

Dedupe key for `output` entries changes from
`(bucket, turnID, "output", isComplete)` to
`(bucket, turnID, "output", segmentId)`. Same envelope replayed (live +
history overlap, or two history fetches) lands on the same entry and is
idempotent. Non-output event types (`tool_use`, `thinking`, etc.) keep
their existing dedupe rules unchanged.

`openSegmentId` lives in the reducer's `TimelineState` keyed by
`(bucket, turnID)`. Cleared when `StatusChange Active→Idle` arrives or when
the turn's entries are pruned.

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

- `tool_use` case: render the tool card as today, plus an embedded result
  region driven by `metadata.tool_result`. Collapsed by default with a
  success/failure indicator; tap to expand the result text. If
  `metadata.tool_result` is absent, show a "running…" placeholder.
- `tool_result` case: removed (results no longer arrive as standalone
  entries from the reducer).
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
   complete), tool_use (metadata.tool_result populated), output("C",
   complete).
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
summary when `metadata.tool_result` is set.

SwiftUI snapshot tests for `EventFeedView` / `StreamingDetailView` are
intentionally skipped — low ROI on iOS 26 for this kind of structural
change.

## Risks and edge cases

- **`SessionDetailView.activeStreamLastLine`** currently expects "one
  rolling output line"; with segments it should read from the open
  segment's entry. Behaviorally near-identical but worth a spot-check in
  the live preview.
- **Main feed visual regression**: feed summary now shows the *last* reply
  segment instead of the whole concatenated reply. For turns that end with
  tool-only activity and no trailing text, fallback rule applies. Watch
  feed during development; if the trailing-segment summary looks too
  truncated, we can revisit feed rule in a follow-up (out of scope here).
- **Dedupe pruning**: `pruneDuplicateRuntimeEvents`
  (`SessionDetailViewModel.swift:286`) currently expects the old
  per-turn-single-output invariant. Audit the prune logic — it must
  preserve multi-segment same-turn entries.
- **Reducer state size**: `openSegmentId` is one optional Int per active
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
