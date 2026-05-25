import Foundation

/// Pure-value reducer over the timeline state. Encodes the contract
/// documented in `TimelineInput.swift` (the seven in-place mutation
/// cases + per-variant identity / ordering keys) so that production
/// migration off the inline-handler path in `SessionDetailViewModel`
/// has a fixed target.
///
/// **Not wired into production yet.** Lives here as the executable
/// contract anchor for Phase 4 main. The surrounding store + view
/// migration that consumes this reducer needs recorded session traces
/// to land safely; that's the prerequisite. Until then this file +
/// `ChatTimelineReducerTests` documents the intended semantics in
/// runnable form, decoupled from SwiftData and SwiftUI.
public enum ChatTimelineReducer {

    /// Apply one input to the state. Idempotent under replay when the
    /// input's identity key has already been seen — re-applying the
    /// same `(.acp envelopeSequence)` / `.liveMessage messageID` /
    /// `.historyMessage supabaseMessageID` / `.localPrompt clientID` /
    /// `.permissionResolution requestID` is a no-op.
    public static func apply(_ input: TimelineInput,
                             to state: inout TimelineState) {
        switch input {
        case .acp(let a): applyAcp(a, to: &state)
        case .liveMessage(let m): applyLive(m, to: &state)
        case .historyMessage(let h): applyHistory(h, to: &state)
        case .localPrompt(let p): applyLocal(p, to: &state)
        case .permissionResolution(let r): applyPermission(r, to: &state)
        }
    }

    // MARK: - .acp

    static func applyAcp(_ input: AcpInput, to state: inout TimelineState) {
        let bucket = input.agentBucketKey
        let turnKey = "\(bucket)|\(input.turnID ?? "")"

        switch input.acpEvent.event {
        case .output(let o):
            // Guard 1: Replay of a completed turn. If we already have a
            // completed output entry for this (bucket, turnID) AND no
            // segment is currently open for that turn, this incoming
            // envelope is a replay (daemon-restart resequenced history,
            // or Supabase history seed overlapping with live). Update
            // text in place and return — do NOT open a new segment.
            if o.isComplete,
               state.openSegmentByTurn[turnKey] == nil,
               let turnID = input.turnID, !turnID.isEmpty,
               let idx = state.entries.lastIndex(where: {
                   $0.eventType == "output"
                       && $0.isComplete
                       && $0.turnID == turnID
                       && ($0.senderActorID ?? "") == bucket
               }) {
                state.entries[idx].text = o.text
                if !input.acpEvent.model.isEmpty {
                    state.entries[idx].model = input.acpEvent.model
                }
                state.streamingAgentSet.remove(bucket)
                state.streamingTextByAgent[bucket] = nil
                state.streamingModelByAgent[bucket] = nil
                return
            }

            // Guard 2: Sequence dedupe fallback for envelopes that lack
            // a usable turnID. Same-sequence re-application would otherwise
            // append a duplicate. Skip silently when we already have a
            // *complete* entry at this (sequence, bucket) — applies only
            // when turnID is missing because the turnID-based replay guard
            // above already covers the keyed case. We require isComplete
            // so that legitimate streaming deltas sharing a sequence number
            // (no turnID path) still accumulate onto the open segment.
            if input.envelopeSequence > 0,
               (input.turnID?.isEmpty ?? true),
               state.entries.contains(where: {
                   $0.sequence == input.envelopeSequence
                       && ($0.senderActorID ?? "") == bucket
                       && $0.isComplete
               }) {
                return
            }

            // Guard 3: stop()-saved synthetic incomplete-output entries
            // exist in state.entries but are NOT registered in
            // openSegmentByTurn (they predate this reducer's segment
            // tracking). A live completion event for this bucket should
            // upgrade the sentinel in place rather than creating a
            // second entry. Only fires when no segment is currently
            // open for this turn.
            if state.openSegmentByTurn[turnKey] == nil,
               let idx = incompleteOutputIndex(for: bucket, in: state),
               state.entries[idx].turnID == nil {
                state.entries[idx].text = o.text
                if !input.acpEvent.model.isEmpty {
                    state.entries[idx].model = input.acpEvent.model
                }
                if o.isComplete {
                    state.entries[idx].isComplete = true
                    if let turnID = input.turnID, !turnID.isEmpty {
                        state.entries[idx].turnID = turnID
                    }
                    state.streamingAgentSet.remove(bucket)
                    state.streamingTextByAgent[bucket] = nil
                    state.streamingModelByAgent[bucket] = nil
                }
                return
            }

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

        case .thinking(let t):
            if let lastIdx = state.entries.indices.last,
               state.entries[lastIdx].eventType == "thinking",
               (state.entries[lastIdx].senderActorID ?? "") == bucket {
                state.entries[lastIdx].text = (state.entries[lastIdx].text ?? "") + t.text
                if !input.acpEvent.model.isEmpty {
                    state.entries[lastIdx].model = input.acpEvent.model
                }
            } else {
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "thinking",
                    text: t.text,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    model: input.acpEvent.model.isEmpty ? nil : input.acpEvent.model
                ))
            }

        case .toolUse(let tu):
            if let idx = state.entries.lastIndex(where: { $0.eventType == "tool_use" && $0.toolID == tu.toolID }) {
                if !tu.description_p.isEmpty {
                    state.entries[idx].text = tu.description_p
                }
                if !tu.toolName.isEmpty {
                    state.entries[idx].toolName = tu.toolName
                }
                if state.entries[idx].toolID == nil {
                    state.entries[idx].toolID = tu.toolID
                }
            } else {
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "tool_use",
                    text: tu.description_p,
                    toolID: tu.toolID,
                    toolName: tu.toolName,
                    senderActorID: bucket,
                    timestamp: input.timestamp
                ))
            }

        case .toolResult(let tr):
            if let idx = state.entries.lastIndex(where: { $0.eventType == "tool_use" && $0.toolID == tr.toolID }) {
                state.entries[idx].success = tr.success
                state.entries[idx].isComplete = true
            } else {
                // Out-of-order arrival — append a standalone tool_result.
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "tool_result",
                    text: tr.summary,
                    toolID: tr.toolID,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    isComplete: true,
                    success: tr.success
                ))
            }

        case .error(let e):
            state.entries.append(makeEntry(
                sequence: input.envelopeSequence,
                eventType: "error",
                text: e.message,
                senderActorID: bucket,
                timestamp: input.timestamp
            ))

        case .permissionRequest(let pr):
            state.entries.append(makeEntry(
                sequence: input.envelopeSequence,
                eventType: "permission_request",
                text: pr.description_p,
                toolID: pr.requestID,
                toolName: pr.toolName,
                senderActorID: bucket,
                timestamp: input.timestamp
            ))

        case .planUpdate(let pu):
            let text = pu.entries.map { entry -> String in
                let icon = entry.status == "completed" ? "done"
                         : entry.status == "in_progress" ? "wip"
                         : "todo"
                return "[\(icon)] \(entry.content)"
            }.joined(separator: "\n")
            if let idx = state.entries.lastIndex(where: {
                $0.eventType == "plan_update"
                    && ($0.senderActorID ?? "") == bucket
            }) {
                state.entries[idx].text = text
                if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            } else {
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "plan_update",
                    text: text,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    turnID: input.turnID
                ))
            }

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

        case .availableCommands(let upd):
            var seen = Set<String>()
            let next = upd.commands
                .filter { !$0.name.isEmpty && seen.insert($0.name).inserted }
                .map { SlashCommand(name: $0.name,
                                    description: $0.description_p,
                                    inputHint: $0.inputHint) }
            if next != state.availableCommands {
                state.availableCommands = next
            }

        case .raw, .none:
            // Raw tool_title_update + future event types: leave the
            // entries alone. The production VM has a hand-rolled
            // parser for `tool_title_update`; that's intentionally
            // outside the reducer's MVP scope. Other `raw` payloads
            // are ignored.
            break
        }
    }

    // MARK: - .liveMessage

    static func applyLive(_ input: LiveMessageInput, to state: inout TimelineState) {
        // Identity dedupe: messageID already present → no-op.
        if state.entries.contains(where: { $0.id == input.messageID }) { return }

        // Local prompt merge: same clientID round-tripped from a prior
        // .localPrompt → replace that entry in place. We swap the id
        // for the server-assigned messageID so future history seeds
        // dedupe correctly.
        if let clientLocalID = input.clientLocalID,
           let idx = state.entries.firstIndex(where: { $0.clientID == clientLocalID }) {
            state.entries[idx].id = input.messageID
            state.entries[idx].clientID = nil
            state.entries[idx].timestamp = input.createdAt
            return
        }

        state.entries.append(TimelineEntry(
            id: input.messageID,
            eventType: "user_prompt",
            text: input.content,
            isComplete: true,
            senderActorID: input.senderActorID,
            timestamp: input.createdAt
        ))
    }

    // MARK: - .historyMessage

    static func applyHistory(_ input: HistoryInput, to state: inout TimelineState) {
        // Residual-streaming cleanup. Cold-start `start()` may have restored
        // `streamingAgentSet[bucket]` from a `stop()`-saved synthetic
        // incomplete output — but if Supabase shows the turn already
        // completed (because the daemon finished while iOS was disconnected),
        // the typing indicator is stale and must come down. Clear when the
        // incoming history row is a complete `output` for this bucket AND
        // the streaming partial we saved is a prefix of the finalized text
        // (so we don't wipe an unrelated, genuinely-active stream for the
        // same agent that just happened to land mid-seed).
        defer {
            if input.kind == .output,
               let bucket = input.senderActorID,
               !bucket.isEmpty {
                let partial = state.streamingTextByAgent[bucket] ?? ""
                // Only clear when our saved partial is consistent with the
                // finalized text — empty partial (no active stream) or a
                // prefix of the completed content. Otherwise leave streaming
                // state alone; it belongs to an unrelated active turn.
                if partial.isEmpty || input.content.hasPrefix(partial) {
                    state.streamingAgentSet.remove(bucket)
                    state.streamingTextByAgent[bucket] = nil
                    state.streamingModelByAgent[bucket] = nil
                }
            }
        }

        // Identity dedupe by supabaseMessageID.
        if let idx = state.entries.firstIndex(where: { $0.supabaseMessageID == input.supabaseMessageID }) {
            if state.entries[idx].timestamp != input.createdAt {
                state.entries[idx].timestamp = input.createdAt
            }
            if state.entries[idx].model == nil {
                state.entries[idx].model = input.model
            }
            if state.entries[idx].turnID == nil {
                state.entries[idx].turnID = input.turnID
            }
            return
        }
        let eventType: String = input.kind == .output ? "output" : "user_prompt"

        // Local outbox merge: iOS uses the Supabase message id as the
        // outbox message id for the optimistic prompt row. When the
        // history seed returns that row, merge by this stable id before
        // falling back to content matching. This avoids collapsing the
        // wrong bubble when the user sends the same text twice.
        if let idx = state.entries.firstIndex(where: {
            $0.outboxMessageID == input.supabaseMessageID || $0.id == input.supabaseMessageID
        }) {
            state.entries[idx].supabaseMessageID = input.supabaseMessageID
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            if state.entries[idx].timestamp > input.createdAt {
                state.entries[idx].timestamp = input.createdAt
            }
            return
        }

        // Cross-source dedupe: if the same output content already exists
        // for the same agent (live stream / daemon history finalised before
        // the Supabase history seed ran, or Supabase returned another row id
        // for the same persisted reply), keep one bubble. User prompts stay
        // on the stricter nil-id path below so sending the same text twice
        // does not collapse separate human messages.
        if eventType == "output",
           let idx = state.entries.firstIndex(where: {
               $0.eventType == eventType
                   && ($0.senderActorID ?? "") == (input.senderActorID ?? "")
                   && $0.text == input.content
           }) {
            if state.entries[idx].supabaseMessageID == nil {
                state.entries[idx].supabaseMessageID = input.supabaseMessageID
            }
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            return
        }

        // Prefix upgrade: a live/status flush can persist a completed
        // output fragment before the Supabase history seed returns the
        // authoritative full reply. The fragment has no Supabase id or
        // turn id, and its local timestamp is later than the persisted
        // message timestamp. Replace it in place instead of rendering both.
        if eventType == "output",
           let idx = state.entries.firstIndex(where: {
               guard $0.eventType == "output",
                     $0.supabaseMessageID == nil,
                     $0.turnID == nil,
                     ($0.senderActorID ?? "") == (input.senderActorID ?? ""),
                     let text = $0.text,
                     !text.isEmpty,
                     text.count < input.content.count,
                     input.content.hasPrefix(text),
                     $0.timestamp >= input.createdAt
               else { return false }
               return true
           }) {
            state.entries[idx].text = input.content
            state.entries[idx].timestamp = input.createdAt
            state.entries[idx].supabaseMessageID = input.supabaseMessageID
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            state.entries[idx].turnID = input.turnID
            return
        }

        // Conservative prompt dedupe: if the same content already exists
        // without a Supabase id (live stream finalised before the history
        // seed ran), backfill the id rather than append a duplicate.
        if let idx = state.entries.firstIndex(where: {
            $0.supabaseMessageID == nil
                && $0.eventType == eventType
                && $0.text == input.content
        }) {
            state.entries[idx].supabaseMessageID = input.supabaseMessageID
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            if state.entries[idx].turnID == nil { state.entries[idx].turnID = input.turnID }
            if state.entries[idx].timestamp > input.createdAt {
                state.entries[idx].timestamp = input.createdAt
            }
            return
        }

        // Same-turn merge: when the daemon flushed a single logical turn
        // into multiple AgentReply rows (ToolUse mid-stream cut), reload
        // sees them as N separate rows. Walk back to find an existing
        // entry with matching `turnID` + bucket and concatenate the
        // text instead of producing a second bubble. Only applies to
        // agent output kind — user_prompt rows are never split this way.
        if eventType == "output",
           let turnID = input.turnID,
           !turnID.isEmpty,
           let idx = state.entries.firstIndex(where: {
               $0.eventType == "output"
                   && $0.turnID == turnID
                   && ($0.senderActorID ?? "") == (input.senderActorID ?? "")
           }) {
            let existing = state.entries[idx].text ?? ""
            // Order earlier-row-first by createdAt: if the existing
            // entry's timestamp is later, the incoming chunk belongs
            // at the front. Production loads are createdAt-ordered so
            // this branch is defensive.
            if input.createdAt < state.entries[idx].timestamp {
                state.entries[idx].text = input.content + existing
                state.entries[idx].timestamp = input.createdAt
            } else {
                state.entries[idx].text = existing + input.content
            }
            if state.entries[idx].model == nil { state.entries[idx].model = input.model }
            // Latest row's supabaseMessageID wins as the dedupe key for
            // future re-seeds — first one stays, but we record this one
            // too so a separate re-seed of either id stays a no-op.
            if state.entries[idx].supabaseMessageID == nil {
                state.entries[idx].supabaseMessageID = input.supabaseMessageID
            }
            return
        }

        state.entries.append(TimelineEntry(
            id: UUID().uuidString,
            sequence: UInt64(max(0, input.sequence)),
            eventType: eventType,
            text: input.content,
            isComplete: true,
            senderActorID: input.senderActorID,
            timestamp: input.createdAt,
            model: input.model,
            supabaseMessageID: input.supabaseMessageID,
            turnID: input.turnID
        ))
        // History entries land sorted by createdAt; keep the array
        // ordered so feed-rendering downstream stays consistent.
        state.entries.sort { $0.timestamp < $1.timestamp }
    }

    // MARK: - .localPrompt

    static func applyLocal(_ input: LocalPromptInput, to state: inout TimelineState) {
        // Re-feeding the same clientID is a no-op.
        if state.entries.contains(where: { $0.clientID == input.clientID }) { return }
        state.entries.append(TimelineEntry(
            id: UUID().uuidString,
            eventType: "user_prompt",
            text: input.content,
            isComplete: true,
            senderActorID: input.senderActorID,
            timestamp: input.createdAt,
            clientID: input.clientID,
            // clientID doubles as the outboxMessageID so the chat
            // view's status-dot accessory keeps working after the
            // reducer takes over from the inline handler.
            outboxMessageID: input.clientID
        ))
    }

    // MARK: - .permissionResolution

    static func applyPermission(_ input: PermissionResolutionInput, to state: inout TimelineState) {
        // Find the matching permission_request entry; drop silently
        // if there's no match (out-of-order arrival).
        guard let idx = state.entries.firstIndex(where: {
            $0.eventType == "permission_request" && $0.toolID == input.requestID
        }) else { return }
        state.entries[idx].isComplete = true
        state.entries[idx].success = input.granted
    }

    // MARK: - Helpers

    private static func makeEntry(
        sequence: UInt64,
        eventType: String,
        text: String? = nil,
        toolID: String? = nil,
        toolName: String? = nil,
        senderActorID: String?,
        timestamp: Date,
        model: String? = nil,
        isComplete: Bool = false,
        success: Bool? = nil,
        turnID: String? = nil
    ) -> TimelineEntry {
        TimelineEntry(
            id: UUID().uuidString,
            sequence: sequence,
            eventType: eventType,
            text: text,
            toolID: toolID,
            toolName: toolName,
            isComplete: isComplete,
            success: success,
            senderActorID: senderActorID,
            timestamp: timestamp,
            model: model,
            turnID: turnID
        )
    }

    private static func incompleteOutputIndex(for bucket: String,
                                              in state: TimelineState) -> Int? {
        // Walk newest-first since incomplete outputs cluster near the
        // end; matches the production VM's hot-path optimization.
        var i = state.entries.count - 1
        while i >= 0 {
            let e = state.entries[i]
            if e.eventType == "output",
               !e.isComplete,
               (e.senderActorID ?? "") == bucket {
                return i
            }
            i -= 1
        }
        return nil
    }

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
}
