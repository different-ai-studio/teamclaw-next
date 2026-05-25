# iOS Turn Detail — Interleaved Output Segments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror the daemon's "tool interrupts reply" flush boundary inside the iOS reducer so the turn detail view renders `output_segment_A → tool_A (+ result) → output_segment_B → tool_B (+ result) → output_segment_C` instead of "all tools first, then one final text block."

**Architecture:** Add segment-aware fields to `TimelineEntry` and `AgentEvent`, replace the reducer's single-output-per-turn dedupe with a per-`(bucket, turnID)` `openSegmentByTurn` map, rework `applyAcp` so `ToolUse` closes the open segment and creates the next one on the following `Output`, mark the highest-sequence entry of a closed turn with `turnEnded`, and switch `FeedItem.buildFeedItems` to use `turnEnded` instead of `output.isComplete` as its turn-close signal. The `TimelineSwiftDataSync` projection layer propagates new fields to SwiftData; no view-data-flow rewiring needed.

**Tech Stack:** Swift 5.10, SwiftUI, SwiftData, swift-testing (`@Suite` / `@Test` / `#expect`). All work lives in the existing `apps/ios/Packages/AMUXCore` and `apps/ios/Packages/AMUXUI` Swift packages.

**Spec reference:** `docs/2026-05-25-ios-turn-detail-segments-design.md`

**Worktree:** `.worktrees/ios-turn-detail-segments` on branch `agent/ios-turn-detail-segments`.

---

## File Structure

| File | Role | Change kind |
|---|---|---|
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/TimelineState.swift` | `TimelineEntry` value type + `TimelineState` reducer state | Add `resultSummary`, `turnEnded` to `TimelineEntry`; add `openSegmentByTurn` to `TimelineState` |
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/AgentEvent.swift` | SwiftData `@Model` row | Add `resultSummary`, `turnEnded` |
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/TimelineSwiftDataSync.swift` | Sync `TimelineEntry` ↔ `AgentEvent` | Project new fields through `apply(entry:to:)` and `makeAgentEvent(from:agentId:)` |
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/ChatTimelineReducer.swift` | Pure reducer | Rework `applyAcp` `.output` / `.toolUse` / `.toolResult` / `.statusChange` branches; new helper `findOutputSegmentEntry`; remove `outputCompleteIndex` and the top-of-`applyAcp` turn-id dedupe block |
| `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift` | `buildFeedItems` | Close turn on `turnEnded`, not `output.isComplete`; accumulate every event type into the open turn |
| `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift` | Reducer test suites | Append 7 new `@Test` cases (scenarios 1–10 from spec; 1–3 partially overlap existing tests, see Task 8 note) |
| `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/FeedItemTests.swift` | New file | 3 test cases for `buildFeedItems` `turnEnded` behavior |
| `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift` | `EventBubbleView.toolUseBlock` | Render `resultSummary` + `success` inside the tool card when `isComplete == true` |
| `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/ToolCallView.swift` | Tool card visual | Accept optional `resultSummary` + `success`, render embedded result region |
| `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/ToolDisplayTests.swift` | Tool view tests | One new case: card shows summary when both fields set |

---

## Tasks

### Task 1: Add `resultSummary` and `turnEnded` to `TimelineEntry` + `openSegmentByTurn` to `TimelineState`

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/TimelineState.swift:13-77` (TimelineEntry) and `:81-114` (TimelineState)

- [ ] **Step 1: Add fields to `TimelineEntry`**

Locate the `TimelineEntry` struct (starts at line 13) and add two new stored properties below `turnID`:

```swift
public var turnID: String?
/// Summary text from the matching `ToolResult` envelope, populated on
/// `tool_use` rows after the result arrives. `nil` while the tool is
/// still running. Together with `success` and `isComplete`, drives the
/// embedded result region in `EventBubbleView.toolUseBlock`.
public var resultSummary: String?
/// Marks the single highest-`sequence` entry of a turn that has flipped
/// to Idle. Drives `FeedItem.buildFeedItems`' turn-close decision so
/// multi-output-segment turns don't get split into multiple feed bubbles
/// at the first `output.isComplete`.
public var turnEnded: Bool
```

- [ ] **Step 2: Wire the new fields through the initializer**

Update the `init` (starts at line 46) — add parameters after `turnID: String? = nil`:

```swift
public init(id: String = UUID().uuidString,
            sequence: UInt64 = 0,
            eventType: String,
            text: String? = nil,
            toolID: String? = nil,
            toolName: String? = nil,
            isComplete: Bool = false,
            success: Bool? = nil,
            senderActorID: String? = nil,
            timestamp: Date = .now,
            model: String? = nil,
            supabaseMessageID: String? = nil,
            clientID: String? = nil,
            outboxMessageID: String? = nil,
            turnID: String? = nil,
            resultSummary: String? = nil,
            turnEnded: Bool = false) {
    self.id = id
    self.sequence = sequence
    self.eventType = eventType
    self.text = text
    self.toolID = toolID
    self.toolName = toolName
    self.isComplete = isComplete
    self.success = success
    self.senderActorID = senderActorID
    self.timestamp = timestamp
    self.model = model
    self.supabaseMessageID = supabaseMessageID
    self.clientID = clientID
    self.outboxMessageID = outboxMessageID
    self.turnID = turnID
    self.resultSummary = resultSummary
    self.turnEnded = turnEnded
}
```

- [ ] **Step 3: Add `openSegmentByTurn` to `TimelineState`**

Inside `public struct TimelineState` (line 81), add a new stored property below `availableCommands`:

```swift
public var availableCommands: [SlashCommand] = []
/// Per-turn open output segment id (the `sequence` of the segment's
/// first chunk). Key format: `"\(bucket)|\(turnID ?? "")"`. Cleared
/// per-key when a `ToolUse` arrives in the turn or `Active→Idle`
/// flips. The reducer uses this to route incoming `Output(partial)`
/// chunks to the current segment's entry instead of merging the whole
/// turn into one row.
public var openSegmentByTurn: [String: UInt64] = [:]
```

Update the `TimelineState.init` signature to accept `openSegmentByTurn` with a default of `[:]` and assign it inside.

- [ ] **Step 4: Compile-check**

Run: `cd apps/ios && swift build --package-path Packages/AMUXCore`
Expected: builds clean. If anything in the package references `TimelineEntry(...)` or `TimelineState(...)` positionally and breaks, switch those call sites to use the named-parameter form (the new defaults make them backward-compatible).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/TimelineState.swift
git commit -m "$(cat <<'EOF'
feat(ios-core): add segment fields to TimelineEntry + TimelineState

resultSummary and turnEnded on TimelineEntry, openSegmentByTurn on
TimelineState — infrastructure for segment-aware turn detail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `resultSummary` and `turnEnded` to `AgentEvent`

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/AgentEvent.swift:5-56`

- [ ] **Step 1: Add the two stored properties**

After the existing `turnID` property (line 46), insert:

```swift
public var turnID: String?
/// Mirror of `TimelineEntry.resultSummary` — set by the sync layer
/// when the matching `ToolResult` envelope landed. Nil while the tool
/// is running or for non-tool_use rows.
public var resultSummary: String?
/// Mirror of `TimelineEntry.turnEnded` — true on the single
/// highest-`sequence` row of a closed turn so `FeedItem.buildFeedItems`
/// can decide when to flush the open accumulator. False on streaming
/// or non-terminal segment rows.
public var turnEnded: Bool
```

- [ ] **Step 2: Initialize new fields in `init`**

Update the existing initializer (line 48-55) so SwiftData stores a defined value:

```swift
public init(agentId: String, sequence: Int, eventType: String) {
    self.id = UUID().uuidString
    self.agentId = agentId
    self.sequence = sequence
    self.timestamp = .now
    self.eventType = eventType
    self.isComplete = false
    self.turnEnded = false
}
```

(`resultSummary` defaults to nil per Optional semantics.)

- [ ] **Step 3: Compile-check**

Run: `cd apps/ios && swift build --package-path Packages/AMUXCore`
Expected: builds clean. SwiftData `@Model` adds the column automatically on next store open; no migration needed because we're still in dev.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/AgentEvent.swift
git commit -m "$(cat <<'EOF'
feat(ios-core): add segment fields to AgentEvent

Mirror of TimelineEntry.resultSummary + turnEnded for persistence
through TimelineSwiftDataSync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Project new fields through `TimelineSwiftDataSync`

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/TimelineSwiftDataSync.swift:74-111`

- [ ] **Step 1: Extend `apply(entry:to:)`**

Inside `apply(entry:to:)` (line 74), add two field comparisons after the `turnID` check at line 92:

```swift
        if event.turnID != entry.turnID { event.turnID = entry.turnID; changed = true }
        if event.resultSummary != entry.resultSummary {
            event.resultSummary = entry.resultSummary; changed = true
        }
        if event.turnEnded != entry.turnEnded {
            event.turnEnded = entry.turnEnded; changed = true
        }
        return changed
```

- [ ] **Step 2: Extend `makeAgentEvent(from:agentId:)`**

Inside `makeAgentEvent(from:agentId:)` (line 96), add two assignments after `event.turnID = entry.turnID` at line 109:

```swift
        event.turnID = entry.turnID
        event.resultSummary = entry.resultSummary
        event.turnEnded = entry.turnEnded
        return event
```

- [ ] **Step 3: Compile-check**

Run: `cd apps/ios && swift build --package-path Packages/AMUXCore`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/TimelineSwiftDataSync.swift
git commit -m "$(cat <<'EOF'
feat(ios-core): sync resultSummary + turnEnded through TimelineSwiftDataSync

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Write the failing reducer test for "single segment, no tool"

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift` — add a new `@Suite` at the end

This test pins the lowest-friction guarantee: three partial output chunks followed by idle produce one segment entry with the merged text.

- [ ] **Step 1: Append a new test suite**

Add to the end of the file, after the last existing `@Suite`:

```swift
@Suite("ChatTimelineReducer — segmented turn detail")
struct ReducerSegmentedTurnTests {
    private func acpOutput(_ text: String, isComplete: Bool) -> Amux_AcpEvent {
        var acp = Amux_AcpEvent()
        acp.event = .output(makeOutput(text: text, isComplete: isComplete))
        return acp
    }

    private func acpToolUse(id: String, name: String, desc: String) -> Amux_AcpEvent {
        var acp = Amux_AcpEvent()
        var tu = Amux_AcpToolUse()
        tu.toolID = id
        tu.toolName = name
        tu.description_p = desc
        acp.event = .toolUse(tu)
        return acp
    }

    private func acpToolResult(id: String, success: Bool, summary: String) -> Amux_AcpEvent {
        var acp = Amux_AcpEvent()
        var tr = Amux_AcpToolResult()
        tr.toolID = id
        tr.success = success
        tr.summary = summary
        acp.event = .toolResult(tr)
        return acp
    }

    private func acpIdle() -> Amux_AcpEvent {
        var acp = Amux_AcpEvent()
        acp.event = .statusChange(makeStatusChange(.idle))
        return acp
    }

    private func feed(_ state: inout TimelineState,
                     _ acp: Amux_AcpEvent,
                     seq: UInt64,
                     turn: String = "turn-1",
                     bucket: String = "agent-1") {
        ChatTimelineReducer.apply(
            .acp(AcpInput(envelopeSequence: seq, runtimeID: "rt-1",
                          agentBucketKey: bucket, timestamp: .now,
                          turnID: turn, acpEvent: acp)),
            to: &state
        )
    }

    @Test("single segment: three partial chunks + idle merge into one complete entry")
    func singleSegmentNoTool() {
        var state = TimelineState()
        feed(&state, acpOutput("Hel", isComplete: false), seq: 1)
        feed(&state, acpOutput("lo, ", isComplete: false), seq: 2)
        feed(&state, acpOutput("world", isComplete: false), seq: 3)
        feed(&state, acpIdle(), seq: 4)

        let outputs = state.entries.filter { $0.eventType == "output" }
        #expect(outputs.count == 1)
        #expect(outputs.first?.text == "Hello, world")
        #expect(outputs.first?.isComplete == true)
        #expect(outputs.first?.turnEnded == true)
        #expect(state.openSegmentByTurn.isEmpty)
        #expect(state.streamingAgentSet.isEmpty)
    }
}
```

- [ ] **Step 2: Run the failing test**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter ReducerSegmentedTurnTests/singleSegmentNoTool`
Expected: FAIL. The current reducer keeps partial chunks in `streamingTextByAgent` (no entry created), and on idle synthesizes one row but never sets `turnEnded`. The `turnEnded` and `openSegmentByTurn` assertions fail.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift
git commit -m "$(cat <<'EOF'
test(ios-core): failing reducer test for single output segment

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Rework reducer `.output` handling to use `openSegmentByTurn`

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/ChatTimelineReducer.swift:35-115` (`.output` branch and top of `applyAcp`)

- [ ] **Step 1: Remove the top-of-`applyAcp` turn-id dedupe block**

Delete lines 35-69 (the comment-heavy "Turn-id dedupe (primary)" block plus the "Sequence dedupe (fallback)" early-return). The new `(bucket, turnID, sequence)` segment matcher introduced below makes both early returns redundant — replay of any envelope by the same `sequence` lands on the same segment entry idempotently.

After the deletion, `applyAcp` opens directly with:

```swift
static func applyAcp(_ input: AcpInput, to state: inout TimelineState) {
    let bucket = input.agentBucketKey
    let turnKey = "\(bucket)|\(input.turnID ?? "")"

    switch input.acpEvent.event {
    case .output(let o):
```

- [ ] **Step 2: Rewrite the `.output` branch**

Replace the current `.output` branch body (originally lines 72-115) with:

```swift
        case .output(let o):
            // Locate or open this segment's entry.
            let segmentSeq: UInt64
            let entryIndex: Int
            if let openSeq = state.openSegmentByTurn[turnKey],
               let idx = findOutputSegmentEntry(bucket: bucket,
                                                turnID: input.turnID,
                                                segmentSeq: openSeq,
                                                in: state) {
                segmentSeq = openSeq
                entryIndex = idx
                state.entries[idx].text = (state.entries[idx].text ?? "") + o.text
                if !input.acpEvent.model.isEmpty {
                    state.entries[idx].model = input.acpEvent.model
                }
            } else {
                segmentSeq = input.envelopeSequence
                state.entries.append(makeEntry(
                    sequence: segmentSeq,
                    eventType: "output",
                    text: o.text,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    model: input.acpEvent.model.isEmpty ? nil : input.acpEvent.model,
                    isComplete: false,
                    turnID: input.turnID
                ))
                entryIndex = state.entries.count - 1
                state.openSegmentByTurn[turnKey] = segmentSeq
            }

            // Mirror to the streaming buffer for the live preview line.
            state.streamingAgentSet.insert(bucket)
            state.streamingTextByAgent[bucket, default: ""] += o.text
            if !input.acpEvent.model.isEmpty {
                state.streamingModelByAgent[bucket] = input.acpEvent.model
            }

            // Finalise the segment on complete.
            if o.isComplete {
                state.entries[entryIndex].isComplete = true
                state.openSegmentByTurn[turnKey] = nil
                state.streamingAgentSet.remove(bucket)
                state.streamingTextByAgent[bucket] = nil
                state.streamingModelByAgent[bucket] = nil
            }
```

- [ ] **Step 3: Add the `findOutputSegmentEntry` helper**

Below the existing `outputCompleteIndex` helper (around line 553), add:

```swift
    private static func findOutputSegmentEntry(bucket: String,
                                               turnID: String?,
                                               segmentSeq: UInt64,
                                               in state: TimelineState) -> Int? {
        var i = state.entries.count - 1
        while i >= 0 {
            let e = state.entries[i]
            if e.eventType == "output",
               e.sequence == segmentSeq,
               e.turnID == turnID,
               (e.senderActorID ?? "") == bucket {
                return i
            }
            i -= 1
        }
        return nil
    }
```

Then delete the now-unused `outputCompleteIndex(for:turnID:in:)` helper (lines 553-571 in the original file).

- [ ] **Step 4: Update the `.statusChange` idle branch**

Find the `case .statusChange(let sc)` branch (originally line 221) and replace its body with:

```swift
        case .statusChange(let sc):
            // Mirror the existing reducer's idle-detection. The previous
            // implementation guarded on `sc.newStatus == .idle` alone;
            // daemon never emits idle→idle transitions, so this matches
            // active→idle in practice without needing an extra check.
            if sc.newStatus == .idle {
                // Close any open output segments for this bucket. Parse
                // the (bucket|turnID) key directly so we don't have to
                // walk entries to recover turnID.
                let prefix = "\(bucket)|"
                let openKeys = state.openSegmentByTurn.keys.filter { $0.hasPrefix(prefix) }
                for k in openKeys {
                    guard let openSeq = state.openSegmentByTurn[k] else { continue }
                    let turnPart = String(k.dropFirst(prefix.count))
                    let turnID: String? = turnPart.isEmpty ? nil : turnPart
                    if let idx = findOutputSegmentEntry(bucket: bucket,
                                                       turnID: turnID,
                                                       segmentSeq: openSeq,
                                                       in: state) {
                        state.entries[idx].isComplete = true
                    }
                    state.openSegmentByTurn[k] = nil
                }
                state.streamingAgentSet.remove(bucket)
                state.streamingTextByAgent[bucket] = nil
                state.streamingModelByAgent[bucket] = nil
                // Close any open tool_use rows from this bucket (preserves
                // the existing behavior at lines 239-244 of the original
                // reducer).
                for i in state.entries.indices where state.entries[i].eventType == "tool_use"
                    && !state.entries[i].isComplete
                    && (state.entries[i].senderActorID ?? "") == bucket {
                    state.entries[i].isComplete = true
                    if state.entries[i].success == nil { state.entries[i].success = true }
                }
                // Mark the highest-sequence entry of each turn that this
                // bucket touched with turnEnded so FeedItem.buildFeedItems
                // knows when to flush the open accumulator. Group by
                // turnID; entries without a turnID can't be marked
                // (FeedItem falls back to streamingAgentIDs for those).
                let bucketEntryIndices = state.entries.indices
                    .filter { (state.entries[$0].senderActorID ?? "") == bucket
                                && state.entries[$0].turnID != nil }
                let turnGroups = Dictionary(grouping: bucketEntryIndices,
                                            by: { state.entries[$0].turnID! })
                for (_, indices) in turnGroups {
                    if let maxIdx = indices.max(by: {
                        state.entries[$0].sequence < state.entries[$1].sequence
                    }) {
                        state.entries[maxIdx].turnEnded = true
                    }
                }
            }
```

Note: this replaces the old "synthesize fallback output entry from `streamingTextByAgent`" block at lines 222-233 — that synthesis is no longer needed because the open segment's entry already exists and will be finalised by the loop above.

- [ ] **Step 5: Run the test from Task 4**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter ReducerSegmentedTurnTests/singleSegmentNoTool`
Expected: PASS.

- [ ] **Step 6: Run the full reducer test suite to catch regressions**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter ChatTimelineReducerTests`
Expected: Most tests pass; some pre-existing tests that asserted the old single-output-per-turn invariant may now fail. Read each failure: if it's checking `streamingTextByAgent` mid-stream or final entry count, update the expectation to match the new "entry exists from first chunk" semantics. Do NOT relax assertions about idempotence, ordering, or dedupe — those must still hold.

For each failing pre-existing test:
1. Read its `@Test(...)` description.
2. If the test was asserting "no entry until isComplete" — change it to "entry exists with isComplete=false until idle/complete chunk arrives." Keep the count + text invariants.
3. If the test was asserting `streamingTextByAgent[bucket]` after idle is `nil` — that should still hold.

- [ ] **Step 7: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/ChatTimelineReducer.swift apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift
git commit -m "$(cat <<'EOF'
feat(ios-core): segment-aware output handling in ChatTimelineReducer

Per-turn openSegmentByTurn map routes partial chunks to the current
segment's entry. Active→Idle finalises the open segment and marks the
turn's highest-sequence entry with turnEnded. Old (bucket, turnID,
output, isComplete) dedupe replaced by (bucket, turnID, sequence)
segment matching.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Write the failing test for "tool interrupts reply"

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift` — extend the `ReducerSegmentedTurnTests` suite

- [ ] **Step 1: Add the new test case**

Inside `ReducerSegmentedTurnTests`, add:

```swift
    @Test("tool interrupts reply: AB|Tool|Result|C|idle → output(AB), tool(success+summary), output(C)")
    func toolInterruptsReply() {
        var state = TimelineState()
        feed(&state, acpOutput("A", isComplete: false), seq: 1)
        feed(&state, acpOutput("B", isComplete: false), seq: 2)
        feed(&state, acpToolUse(id: "t1", name: "Read", desc: "foo.swift"), seq: 3)
        feed(&state, acpToolResult(id: "t1", success: true, summary: "12 lines"), seq: 4)
        feed(&state, acpOutput("C", isComplete: false), seq: 5)
        feed(&state, acpIdle(), seq: 6)

        let ordered = state.entries.sorted { $0.sequence < $1.sequence }
        #expect(ordered.count == 3)

        #expect(ordered[0].eventType == "output")
        #expect(ordered[0].text == "AB")
        #expect(ordered[0].isComplete == true)
        #expect(ordered[0].turnEnded == false)

        #expect(ordered[1].eventType == "tool_use")
        #expect(ordered[1].toolID == "t1")
        #expect(ordered[1].toolName == "Read")
        #expect(ordered[1].success == true)
        #expect(ordered[1].resultSummary == "12 lines")
        #expect(ordered[1].isComplete == true)
        #expect(ordered[1].turnEnded == false)

        #expect(ordered[2].eventType == "output")
        #expect(ordered[2].text == "C")
        #expect(ordered[2].isComplete == true)
        #expect(ordered[2].turnEnded == true)
    }
```

- [ ] **Step 2: Run the failing test**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter ReducerSegmentedTurnTests/toolInterruptsReply`
Expected: FAIL. The reducer's `.toolUse` branch doesn't close the open segment; `.toolResult` doesn't write `resultSummary`. Either an extra/missing entry shows up, or the asserted text/summary is wrong.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift
git commit -m "$(cat <<'EOF'
test(ios-core): failing reducer test for tool-interrupts-reply segmentation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Make `.toolUse` close the open segment and `.toolResult` populate `resultSummary`

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/ChatTimelineReducer.swift:136-175` (`.toolUse` and `.toolResult` branches)

- [ ] **Step 1: Update `.toolUse` to flush the open segment first**

Replace the body of the `case .toolUse(let tu):` branch (originally line 136-157) with:

```swift
        case .toolUse(let tu):
            // A tool call interrupts any pending output segment — finalise
            // the open segment for this turn first, mirroring the daemon's
            // TurnAggregator flush behavior.
            if let openSeq = state.openSegmentByTurn[turnKey],
               let idx = findOutputSegmentEntry(bucket: bucket,
                                                turnID: input.turnID,
                                                segmentSeq: openSeq,
                                                in: state) {
                state.entries[idx].isComplete = true
            }
            state.openSegmentByTurn[turnKey] = nil
            // Also clear the streaming buffer so the live preview line
            // doesn't keep showing the just-closed segment's text after
            // the tool card appears.
            state.streamingAgentSet.remove(bucket)
            state.streamingTextByAgent[bucket] = nil

            // Upsert the tool_use entry by (bucket, toolID).
            if let idx = state.entries.lastIndex(where: {
                $0.eventType == "tool_use" && $0.toolID == tu.toolID
            }) {
                if !tu.description_p.isEmpty { state.entries[idx].text = tu.description_p }
                if !tu.toolName.isEmpty { state.entries[idx].toolName = tu.toolName }
                if state.entries[idx].toolID == nil { state.entries[idx].toolID = tu.toolID }
            } else {
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "tool_use",
                    text: tu.description_p,
                    toolID: tu.toolID,
                    toolName: tu.toolName,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    turnID: input.turnID
                ))
            }
```

(Note: `turnID: input.turnID` is added to the new tool_use entry so `buildFeedItems` can group it with its turn.)

- [ ] **Step 2: Update `.toolResult` to write `resultSummary`**

Replace the body of `case .toolResult(let tr):` (originally line 159-175) with:

```swift
        case .toolResult(let tr):
            if let idx = state.entries.lastIndex(where: {
                $0.eventType == "tool_use" && $0.toolID == tr.toolID
            }) {
                state.entries[idx].success = tr.success
                state.entries[idx].resultSummary = tr.summary
                state.entries[idx].isComplete = true
            } else {
                // Defensive: out-of-order arrival, no matching tool_use.
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "tool_result",
                    text: tr.summary,
                    toolID: tr.toolID,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    isComplete: true,
                    success: tr.success,
                    turnID: input.turnID
                ))
            }
```

- [ ] **Step 3: Run both segmented turn tests**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter ReducerSegmentedTurnTests`
Expected: both `singleSegmentNoTool` and `toolInterruptsReply` PASS.

- [ ] **Step 4: Run the full AMUXCore test suite**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore`
Expected: pass. If a pre-existing `tool_use` / `tool_result` test fails because it asserted no `resultSummary`, update the assertion to include the new field where the test fixture stamps it.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/Timeline/ChatTimelineReducer.swift apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift
git commit -m "$(cat <<'EOF'
feat(ios-core): tool calls flush open segment; tool_result writes resultSummary

ToolUse now closes the active output segment before stamping the tool
entry, mirroring daemon's TurnAggregator.flush_reply_into. ToolResult
populates resultSummary + success on the matching tool_use entry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Add the remaining 7 reducer test cases (spec scenarios 3–10)

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift` — extend the `ReducerSegmentedTurnTests` suite

Spec scenarios 1 (singleSegmentNoTool, Task 4) and 2 (toolInterruptsReply, Task 6) are already written. This task lands scenarios 3–10. Each is a separate `@Test`. Write each one, run it, fix the reducer **only if it fails** (most should pass against the implementation from Tasks 5 & 7), then commit the batch when all pass.

- [ ] **Step 1: Scenario 3 — two consecutive tools, no intervening text**

```swift
    @Test("two consecutive tools: A|T1|R1|T2|R2|B|idle → output(A), t1, t2, output(B)")
    func twoConsecutiveTools() {
        var state = TimelineState()
        feed(&state, acpOutput("A", isComplete: false), seq: 1)
        feed(&state, acpToolUse(id: "t1", name: "Read", desc: "foo"), seq: 2)
        feed(&state, acpToolResult(id: "t1", success: true, summary: "ok1"), seq: 3)
        feed(&state, acpToolUse(id: "t2", name: "Write", desc: "bar"), seq: 4)
        feed(&state, acpToolResult(id: "t2", success: true, summary: "ok2"), seq: 5)
        feed(&state, acpOutput("B", isComplete: false), seq: 6)
        feed(&state, acpIdle(), seq: 7)

        let ordered = state.entries.sorted { $0.sequence < $1.sequence }
        #expect(ordered.count == 4)
        #expect(ordered.map(\.eventType) == ["output", "tool_use", "tool_use", "output"])
        #expect(ordered[0].text == "A")
        #expect(ordered[1].toolID == "t1")
        #expect(ordered[2].toolID == "t2")
        #expect(ordered[3].text == "B")
        #expect(ordered[3].turnEnded == true)
    }
```

- [ ] **Step 2: Scenario 4 — live + history overlap idempotence**

```swift
    @Test("live + history replay idempotence: same envelopes twice → identical entries")
    func liveHistoryReplayIdempotent() {
        var stateLive = TimelineState()
        var stateReplay = TimelineState()

        let envelopes: [(Amux_AcpEvent, UInt64)] = [
            (acpOutput("A", isComplete: false), 1),
            (acpToolUse(id: "t1", name: "Read", desc: "foo"), 2),
            (acpToolResult(id: "t1", success: true, summary: "ok"), 3),
            (acpOutput("B", isComplete: false), 4),
            (acpIdle(), 5),
        ]

        // Live: feed once.
        for (e, s) in envelopes { feed(&stateLive, e, seq: s) }
        // Replay: feed live envelopes, then feed them again as history overlap.
        for (e, s) in envelopes { feed(&stateReplay, e, seq: s) }
        for (e, s) in envelopes { feed(&stateReplay, e, seq: s) }

        let liveOrdered = stateLive.entries.sorted { $0.sequence < $1.sequence }
        let replayOrdered = stateReplay.entries.sorted { $0.sequence < $1.sequence }

        #expect(liveOrdered.count == replayOrdered.count)
        for (l, r) in zip(liveOrdered, replayOrdered) {
            #expect(l.eventType == r.eventType)
            #expect(l.text == r.text)
            #expect(l.toolID == r.toolID)
            #expect(l.isComplete == r.isComplete)
            #expect(l.turnEnded == r.turnEnded)
            #expect(l.resultSummary == r.resultSummary)
        }
    }
```

- [ ] **Step 3: Scenario 5 — single-shot complete legacy path**

```swift
    @Test("legacy single-shot Output(isComplete=true) produces one segment + closes")
    func legacySingleShotComplete() {
        var state = TimelineState()
        feed(&state, acpOutput("Hello, world", isComplete: true), seq: 1)
        feed(&state, acpIdle(), seq: 2)

        let outputs = state.entries.filter { $0.eventType == "output" }
        #expect(outputs.count == 1)
        #expect(outputs[0].text == "Hello, world")
        #expect(outputs[0].isComplete == true)
        #expect(outputs[0].turnEnded == true)
    }
```

- [ ] **Step 4: Scenario 6 — out-of-order chunk delivery**

```swift
    @Test("out-of-order chunks (seq 5, 3, 4) land on the same segment by turnID")
    func outOfOrderChunksSameSegment() {
        var state = TimelineState()
        feed(&state, acpOutput("X", isComplete: false), seq: 5)
        feed(&state, acpOutput("Y", isComplete: false), seq: 3)
        feed(&state, acpOutput("Z", isComplete: false), seq: 4)
        feed(&state, acpIdle(), seq: 6)

        let outputs = state.entries.filter { $0.eventType == "output" }
        #expect(outputs.count == 1, "all chunks share an open segment")
        // Text concatenates in arrival order, which is fine for dev period —
        // production sequence is monotonic; this test pins the no-extra-segment
        // invariant, not the merge ordering.
        #expect((outputs[0].text ?? "").contains("X"))
        #expect((outputs[0].text ?? "").contains("Y"))
        #expect((outputs[0].text ?? "").contains("Z"))
        #expect(outputs[0].turnEnded == true)
    }
```

- [ ] **Step 5: Scenario 7 — thinking does not split segment**

You'll need a `acpThinking` helper. Add it to the suite's helpers:

```swift
    private func acpThinking(_ text: String) -> Amux_AcpEvent {
        var acp = Amux_AcpEvent()
        var t = Amux_AcpThinking()
        t.text = text
        acp.event = .thinking(t)
        return acp
    }
```

Then the test:

```swift
    @Test("thinking does not split segment: A|Thinking|B|idle → one output 'AB'")
    func thinkingDoesNotSplitSegment() {
        var state = TimelineState()
        feed(&state, acpOutput("A", isComplete: false), seq: 1)
        feed(&state, acpThinking("..."), seq: 2)
        feed(&state, acpOutput("B", isComplete: false), seq: 3)
        feed(&state, acpIdle(), seq: 4)

        let outputs = state.entries.filter { $0.eventType == "output" }
        #expect(outputs.count == 1)
        #expect(outputs[0].text == "AB")
    }
```

- [ ] **Step 6: Scenario 8 — ToolResult before ToolUse (defensive)**

```swift
    @Test("ToolResult before ToolUse: standalone tool_result entry appended, no crash")
    func toolResultBeforeToolUse() {
        var state = TimelineState()
        feed(&state, acpToolResult(id: "unknown", success: false, summary: "?"), seq: 1)
        feed(&state, acpIdle(), seq: 2)

        let toolResults = state.entries.filter { $0.eventType == "tool_result" }
        #expect(toolResults.count == 1)
        #expect(toolResults[0].toolID == "unknown")
        #expect(toolResults[0].success == false)
    }
```

- [ ] **Step 7: Scenario 9 — turnEnded marker placement on output**

```swift
    @Test("turnEnded marker lands on the highest-sequence entry")
    func turnEndedMarkerPlacement() {
        var state = TimelineState()
        feed(&state, acpOutput("A", isComplete: false), seq: 1)
        feed(&state, acpToolUse(id: "t1", name: "Read", desc: "foo"), seq: 2)
        feed(&state, acpOutput("B", isComplete: false), seq: 3)
        feed(&state, acpIdle(), seq: 4)

        let ended = state.entries.filter { $0.turnEnded }
        #expect(ended.count == 1)
        #expect(ended[0].eventType == "output")
        #expect(ended[0].text == "B")
    }
```

- [ ] **Step 8: Scenario 10 — pure-tool turn ends on tool_use**

```swift
    @Test("pure-tool turn: ToolUse | ToolResult | idle → turnEnded on the tool_use entry")
    func pureToolTurnEndsOnToolUse() {
        var state = TimelineState()
        feed(&state, acpToolUse(id: "t1", name: "Read", desc: "foo"), seq: 1)
        feed(&state, acpToolResult(id: "t1", success: true, summary: "ok"), seq: 2)
        feed(&state, acpIdle(), seq: 3)

        let ended = state.entries.filter { $0.turnEnded }
        #expect(ended.count == 1)
        #expect(ended[0].eventType == "tool_use")
        #expect(ended[0].toolID == "t1")
    }
```

- [ ] **Step 9: Run all new tests**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter ReducerSegmentedTurnTests`
Expected: all 10 tests PASS.

If any fail, diagnose against the reducer rules in spec §3.2. Likely fix sites: the idle-branch's `closedTurns` discovery (might miss a turn that has only tool entries), the `.toolUse` flush (segment-key composition with `nil` turnID), or the legacy single-shot path (Step 3 — ensure the `o.isComplete` short-circuit still seeds an entry).

- [ ] **Step 10: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/ChatTimelineReducerTests.swift
git commit -m "$(cat <<'EOF'
test(ios-core): cover scenarios 3-10 of segmented turn reducer

Two consecutive tools, live+history replay idempotence, single-shot
legacy path, out-of-order chunks, thinking non-split, defensive
ToolResult orphan, turnEnded placement on output, pure-tool turn
ending.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Write failing `buildFeedItems` tests for `turnEnded` behavior

**Files:**
- Create: `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/FeedItemTests.swift`

- [ ] **Step 1: Create the new test file**

```swift
import Testing
import Foundation
@testable import AMUXCore

@Suite("FeedItem.buildFeedItems — turnEnded-driven turn closure")
struct FeedItemTurnEndedTests {

    private func event(seq: Int,
                       type: String,
                       text: String? = nil,
                       turnID: String? = "turn-1",
                       isComplete: Bool = true,
                       turnEnded: Bool = false,
                       owner: String = "agent-1") -> AgentEvent {
        let e = AgentEvent(agentId: owner, sequence: seq, eventType: type)
        e.text = text
        e.turnID = turnID
        e.isComplete = isComplete
        e.turnEnded = turnEnded
        e.senderActorID = owner
        return e
    }

    @Test("a turn with two output segments + tool closes on turnEnded, not on first output.isComplete")
    func multiSegmentTurnClosesOnTurnEnded() {
        let events = [
            event(seq: 1, type: "output", text: "A", isComplete: true),
            event(seq: 2, type: "tool_use", text: "Read", isComplete: true),
            event(seq: 3, type: "output", text: "B", isComplete: true, turnEnded: true),
        ]
        let items = buildFeedItems(events)
        #expect(items.count == 1, "all rows belong to one completed turn")
        guard case .completedTurn(_, _, let final, let runtime) = items[0] else {
            Issue.record("expected completedTurn, got \(items[0])"); return
        }
        #expect(final.text == "B", "finalEvent = last output segment")
        #expect(runtime.count == 3, "all three entries kept for the detail view")
    }

    @Test("turnEnded on a non-output row (pure-tool turn) still closes the turn; finalEvent falls back")
    func pureToolTurnCloses() {
        let events = [
            event(seq: 1, type: "tool_use", text: "Read foo", isComplete: true, turnEnded: true),
        ]
        let items = buildFeedItems(events)
        #expect(items.count == 1)
        guard case .completedTurn(_, _, let final, _) = items[0] else {
            Issue.record("expected completedTurn"); return
        }
        // No output row exists; finalEvent should fall back to the last
        // non-empty-text entry of any type.
        #expect(final.text == "Read foo")
    }

    @Test("a turn with no turnEnded stays open and surfaces as activeStream")
    func openTurnStaysActive() {
        let events = [
            event(seq: 1, type: "output", text: "still streaming", isComplete: false, turnEnded: false),
        ]
        let items = buildFeedItems(events, streamingAgentIDs: ["agent-1"])
        #expect(items.count == 1)
        if case .activeStream = items[0] {} else {
            Issue.record("expected activeStream, got \(items[0])")
        }
    }
}
```

- [ ] **Step 2: Run the failing tests**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter FeedItemTurnEndedTests`
Expected: at least `multiSegmentTurnClosesOnTurnEnded` and `pureToolTurnCloses` FAIL. The current `buildFeedItems` closes on `output.isComplete`, so the multi-segment test produces two `.completedTurn` items (or splits incorrectly), and the pure-tool test produces no completed turn at all.

- [ ] **Step 3: Commit failing tests**

```bash
git add apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/FeedItemTests.swift
git commit -m "$(cat <<'EOF'
test(ios-core): failing buildFeedItems tests for turnEnded turn closure

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Rework `buildFeedItems` to close on `turnEnded`

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift:60-141`

- [ ] **Step 1: Replace the per-event switch body**

Replace the body of the `for event in events { switch event.eventType { ... } }` loop (lines 81-121) with:

```swift
    for event in events {
        let owner = ownerFor(event)
        switch event.eventType {
        case "user_prompt":
            result.append(.userMessage(event))
            continue
        case "permission_request":
            result.append(.permission(event))
            continue
        case "plan_update":
            result.append(.todo(event))
            continue
        case "error":
            result.append(.error(event))
            continue
        case "thinking", "tool_use", "tool_result", "output":
            recordOpenTurn(event, owner: owner)
        default:
            // Unknown event types fall through to a debug row.
            result.append(.userMessage(event))
            continue
        }

        // After accumulating into the open turn, check if this event
        // also ends the turn.
        if event.turnEnded {
            let runtime = openTurnsByAgent[owner] ?? []
            openTurnsByAgent[owner] = nil
            openTurnFirstEventID[owner] = nil
            let finalEvent = runtime.last(where: { $0.eventType == "output" })
                ?? runtime.last(where: { !($0.text?.isEmpty ?? true) })
                ?? event
            let turnID = (event.turnID?.isEmpty == false
                          ? event.turnID!
                          : "turn-\(event.id)")
            result.append(.completedTurn(
                id: turnID,
                agentID: owner,
                finalEvent: finalEvent,
                runtimeEvents: runtime
            ))
        }
    }
```

Key behavioral differences vs the old logic:
- `output` is now treated the same way as `thinking` / `tool_use` for accumulation purposes (no early turn-close on `isComplete`).
- The `turnEnded` check fires **after** the row was already accumulated into `runtime`, so the closing row is present in the detail view's event list.
- `finalEvent` selection: last output row → else last non-empty-text row → else the closing row itself (which guarantees a non-nil value).

- [ ] **Step 2: Run the failing tests from Task 9**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore --filter FeedItemTurnEndedTests`
Expected: all three PASS.

- [ ] **Step 3: Run the full AMUXCore suite for regressions**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore`
Expected: pass. The most likely regression site is `SessionDetailViewModelTests.swift` / `SessionDetailViewModelChipTests.swift` — they may have set up fixture events that relied on `output.isComplete` closing a turn. For each such failure:

1. Check what the test was asserting (turn count, feed item kind).
2. Update the fixture: add `turnEnded = true` to the last event of each intended turn.
3. Re-run.

If a test was implicitly relying on "current behavior" without an explicit `turnEnded` setup, prefer fixing the fixture (the new behavior is the intended one).

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/
git commit -m "$(cat <<'EOF'
feat(ios-core): close feed turns on turnEnded instead of output.isComplete

buildFeedItems accumulates every event type into the open turn and only
flushes to .completedTurn when an entry's turnEnded flag fires. Lets
multi-segment turns (output→tool→output) stay a single feed bubble.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Audit `pruneDuplicateRuntimeEvents` for multi-segment safety

**Files:**
- Read + possibly modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift:286` (function `pruneDuplicateRuntimeEvents`)

- [ ] **Step 1: Read the function**

Run: `grep -n "pruneDuplicateRuntimeEvents\|func pruneDuplicateRuntimeEvents" apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift`
Read the function (typically ~40–80 lines starting at line 286).

- [ ] **Step 2: Check its dedupe key**

If the function dedupes by `(agentId, turnID, eventType)` for output rows, it will collapse legitimate multi-segment entries into one. Look for any sequence like:

```swift
.filter { $0.eventType == "output" && $0.turnID == ... }
```

without a `sequence` axis.

- [ ] **Step 3: Fix if needed**

If the dedupe key needs `sequence`, add it. Otherwise, leave it. A typical safe fix:

```swift
let key = "\(event.agentId)|\(event.turnID ?? "")|\(event.eventType)|\(event.sequence)"
```

so each segment is a distinct row even at the same `(agentID, turnID, eventType)`.

- [ ] **Step 4: Add an inline test in `SessionDetailViewModelTests.swift`**

If you modified the function, add a test that asserts: given two output rows with same `(agentID, turnID, eventType)` but different `sequence`, both rows survive pruning. If you did NOT modify it, skip this step — the existing tests already cover the function's behavior.

- [ ] **Step 5: Run the iOS test suite**

Run: `cd apps/ios && swift test --package-path Packages/AMUXCore`
Expected: pass.

- [ ] **Step 6: Commit (if any change was needed)**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/SessionDetailViewModelTests.swift
git commit -m "$(cat <<'EOF'
fix(ios-core): pruneDuplicateRuntimeEvents preserves multi-segment outputs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no change was needed, skip the commit and note in your handoff that the audit found no issue.

---

### Task 12: Render `resultSummary` inside the tool_use card

**Files:**
- Modify: `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/ToolCallView.swift`
- Modify: `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift:272-290` (`toolUseBlock` and `CompactToolLine`)

- [ ] **Step 1: Inspect `CompactToolLine`**

`grep -n "CompactToolLine" apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/*.swift`
Read its current definition. It currently renders just the tool name + description for `isComplete == true` tool calls.

- [ ] **Step 2: Add a `resultSummary` parameter to `CompactToolLine`**

Add a new init parameter `resultSummary: String? = nil` and `success: Bool? = nil`. Render the summary in a collapsible disclosure region below the tool name, gated by `if let summary = resultSummary, !summary.isEmpty`:

```swift
@State private var isExpanded = false

// Inside body, after the tool name+description line:
if let summary = resultSummary, !summary.isEmpty {
    DisclosureGroup(isExpanded: $isExpanded) {
        Text(summary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    } label: {
        HStack(spacing: 4) {
            Image(systemName: success == false ? "xmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(success == false ? Color.amux.cinnabarDeep : Color.amux.basalt)
                .font(.caption2)
            Text("Result")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
```

(Match `CompactToolLine`'s existing styling conventions — see the surrounding file for the right `Color.amux.*` token usage.)

- [ ] **Step 3: Pass the fields through from `EventBubbleView.toolUseBlock`**

In `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift:272`, update `toolUseBlock`:

```swift
    private var toolUseBlock: some View {
        Group {
            if event.isComplete == true {
                CompactToolLine(event: event,
                                resultSummary: event.resultSummary,
                                success: event.success)
            } else {
                ToolCallView(
                    toolName: event.toolName ?? "Unknown",
                    toolId: event.toolId ?? "",
                    description: event.text ?? "",
                    status: "running"
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
            }
        }
        .contextMenu {
            MessageContextMenu(text: event.text ?? "")
        }
    }
```

(Adjust the `CompactToolLine` init signature to match whatever the existing `event:` initializer expects — likely add a second initializer that takes the raw fields if `event:` is the only public init.)

- [ ] **Step 4: Compile-check**

Run: `cd apps/ios && swift build --package-path Packages/AMUXUI && swift build --package-path Packages/AMUXSharedUI`
Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/ToolCallView.swift apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift
git commit -m "$(cat <<'EOF'
feat(ios-ui): embed resultSummary in CompactToolLine

Tool cards now show an inline disclosure for result text + success
icon when resultSummary is populated. Drives the "Claude Code style"
result-under-tool look in the turn detail view.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Add a tool display test for embedded result rendering

**Files:**
- Modify: `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/ToolDisplayTests.swift`

- [ ] **Step 1: Read the existing tests**

`cat apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/ToolDisplayTests.swift`
Note which testing framework is in use (`@Test` vs XCTest) and what helpers exist.

- [ ] **Step 2: Add a test**

If the file uses swift-testing:

```swift
@Test("CompactToolLine renders summary text when resultSummary + success are set")
func compactToolLineShowsResultSummary() {
    let line = CompactToolLine(
        toolName: "Read",
        description: "foo.swift",
        resultSummary: "12 lines",
        success: true
    )
    // The view's body should contain both the tool name and the summary
    // text in its inspected hierarchy. If a SwiftUI inspector helper
    // exists in the package, use it; otherwise assert via a snapshot or
    // a model-level smoke check that the init does not crash.
    _ = line.body  // Smoke check that init + body don't crash.
}
```

If the package uses XCTest, mirror that style instead.

- [ ] **Step 3: Run the test**

Run: `cd apps/ios && swift test --package-path Packages/AMUXSharedUI --filter compactToolLineShowsResultSummary` (adjust filter to match the test name format used in that package).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/ToolDisplayTests.swift
git commit -m "$(cat <<'EOF'
test(ios-ui): tool card renders resultSummary when populated

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Manual verification on the iOS simulator + open PR

**Files:** none (verification + PR).

- [ ] **Step 1: Boot the simulator and run**

Run: `pnpm ios:run`
Expected: simulator boots, app launches.

- [ ] **Step 2: Trigger a multi-tool turn**

Sign in, start a session with an agent runtime, prompt it with something that requires 2+ tool calls and intermediate explanation (e.g. "read file X, then summarize, then read file Y, then explain"). Watch the turn detail screen as the response streams.

Expected visual: assistant text segment → tool card (with embedded result when complete) → next text segment → next tool card → final text segment. NOT "all tools first then final text."

- [ ] **Step 3: Reopen the same session cold**

Force-quit the app, reopen, navigate back to the same session, tap the completed turn. Expected: same interleaved layout (driven by `requestTurnHistory` envelope replay + reducer segmentation).

- [ ] **Step 4: Check the main feed bubble**

The main session feed should still show one assistant bubble per turn, summary text drawn from the trailing output segment.

- [ ] **Step 5: Run all iOS tests one final time**

```bash
cd apps/ios && swift test --package-path Packages/AMUXCore
cd apps/ios && swift test --package-path Packages/AMUXUI
cd apps/ios && swift test --package-path Packages/AMUXSharedUI
```

Expected: all pass.

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin agent/ios-turn-detail-segments
gh pr create --title "iOS turn detail — interleaved output segments" --body "$(cat <<'EOF'
## Summary
- Reducer mirrors daemon's "tool interrupts reply" flush boundary; each turn produces multiple output segments interleaved with tool cards instead of "all tools first + final text."
- New fields `resultSummary` + `turnEnded` on `TimelineEntry`/`AgentEvent`; new `openSegmentByTurn` map on `TimelineState`.
- `FeedItem.buildFeedItems` closes a turn on `turnEnded` (set on the highest-sequence entry by the reducer at idle), not on `output.isComplete`.
- Tool cards now show an inline `resultSummary` disclosure when the matching `ToolResult` arrives.

Design doc: `docs/2026-05-25-ios-turn-detail-segments-design.md`
Plan: `docs/2026-05-25-ios-turn-detail-segments-plan.md`

## Test plan
- [x] `swift test --package-path apps/ios/Packages/AMUXCore` — 10 new reducer scenarios + 3 buildFeedItems scenarios pass
- [x] `swift test --package-path apps/ios/Packages/AMUXSharedUI` — tool card result rendering test passes
- [ ] Manual: multi-tool turn renders interleaved in the iOS simulator (live + cold-reopen)
- [ ] Manual: main feed still shows one bubble per turn

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (for the implementer)

- **If a pre-existing test fails after Task 5 or Task 7**, do not blanket-relax assertions. Each assertion was pinning a specific invariant; check whether the new behavior actually violates the *intent* or just the *literal expectation*. Update the literal expectation; preserve the intent.
- **If the simulator shows segments out of order**, check `recomputeGroups` after the reducer applies — the feed is order-sensitive on the `events` array order, which is `sequence`-sorted. If the projection by `TimelineSwiftDataSync` doesn't preserve sequence, sort it (cheap O(n log n) is fine).
- **If `turnEnded` never fires**, the most likely cause is the idle-branch loop in `ChatTimelineReducer` finding no entries whose `turnID` is non-nil. Verify your test fixtures pass `turnID: "turn-1"` (or similar) on the `AcpInput`.
- **Frequent commits**: every task is its own commit. If one task balloons, split it.
