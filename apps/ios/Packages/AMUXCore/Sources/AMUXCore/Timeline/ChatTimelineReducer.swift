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

        // Turn-id dedupe (primary): same (bucket, turnID, output, isComplete)
        // → idempotent merge regardless of sequence. This is what catches the
        // "same logical completion arrives via MQTT live + daemon history
        // replay + Supabase seed" duplication, since the daemon stamps
        // turn_id on every envelope but renumbers sequence across restarts.
        // Only the completion event needs this guard; deltas and other
        // event types either don't dedupe by identity (deltas → streaming
        // buffer) or arrive at most once per (sequence, bucket).
        if case .output(let outComplete) = input.acpEvent.event,
           outComplete.isComplete,
           let turnID = input.turnID,
           !turnID.isEmpty,
           let idx = outputCompleteIndex(for: bucket, turnID: turnID, in: state) {
            state.entries[idx].text = outComplete.text
            if !input.acpEvent.model.isEmpty {
                state.entries[idx].model = input.acpEvent.model
            }
            state.streamingAgentSet.remove(bucket)
            state.streamingTextByAgent[bucket] = nil
            state.streamingModelByAgent[bucket] = nil
            return
        }

        // Sequence dedupe (fallback): same (sequence, bucket) → no-op.
        // Holds across re-applications in a single daemon lifetime; does
        // NOT survive daemon restarts (sequences renumber) — that's why
        // the turn-id guard above is the primary path.
        if input.envelopeSequence > 0,
           state.entries.contains(where: { $0.sequence == input.envelopeSequence
                                            && ($0.senderActorID ?? "") == input.agentBucketKey }) {
            return
        }

        switch input.acpEvent.event {
        case .output(let o):
            if o.isComplete {
                state.streamingAgentSet.remove(bucket)
                if let idx = incompleteOutputIndex(for: bucket, in: state) {
                    state.entries[idx].text = o.text
                    state.entries[idx].isComplete = true
                    // Backfill turnID so future replays for this turn match
                    // by (bucket, turnID) and don't fall through to append.
                    if let turnID = input.turnID,
                       !turnID.isEmpty,
                       state.entries[idx].turnID == nil {
                        state.entries[idx].turnID = turnID
                    }
                    if !input.acpEvent.model.isEmpty {
                        state.entries[idx].model = input.acpEvent.model
                    }
                } else {
                    state.entries.append(makeEntry(
                        sequence: input.envelopeSequence,
                        eventType: "output",
                        text: o.text,
                        senderActorID: bucket,
                        timestamp: input.timestamp,
                        model: input.acpEvent.model.isEmpty ? nil : input.acpEvent.model,
                        isComplete: true,
                        turnID: input.turnID
                    ))
                }
                state.streamingTextByAgent[bucket] = nil
                state.streamingModelByAgent[bucket] = nil
            } else {
                let firstDelta = !state.streamingAgentSet.contains(bucket)
                if firstDelta, let idx = incompleteOutputIndex(for: bucket, in: state) {
                    // Drop the synthetic stop()-saved entry: its text
                    // seeds the streaming buffer, then it goes away.
                    state.streamingTextByAgent[bucket] = state.entries[idx].text ?? ""
                    state.entries.remove(at: idx)
                }
                state.streamingAgentSet.insert(bucket)
                state.streamingTextByAgent[bucket, default: ""] += o.text
                if !input.acpEvent.model.isEmpty {
                    state.streamingModelByAgent[bucket] = input.acpEvent.model
                }
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
            if sc.newStatus == .idle, state.streamingAgentSet.contains(bucket),
               let text = state.streamingTextByAgent[bucket], !text.isEmpty {
                state.entries.append(makeEntry(
                    sequence: input.envelopeSequence,
                    eventType: "output",
                    text: text,
                    senderActorID: bucket,
                    timestamp: input.timestamp,
                    model: state.streamingModelByAgent[bucket],
                    isComplete: true
                ))
            }
            if sc.newStatus == .idle {
                state.streamingAgentSet.remove(bucket)
                state.streamingTextByAgent[bucket] = nil
                state.streamingModelByAgent[bucket] = nil
                // Close any open tool_use rows from this bucket.
                for i in state.entries.indices where state.entries[i].eventType == "tool_use"
                    && !state.entries[i].isComplete
                    && (state.entries[i].senderActorID ?? "") == bucket {
                    state.entries[i].isComplete = true
                    if state.entries[i].success == nil { state.entries[i].success = true }
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

    private static func outputCompleteIndex(for bucket: String,
                                            turnID: String,
                                            in state: TimelineState) -> Int? {
        // Walk newest-first — completed outputs land at the tail of the
        // turn's event group, and history replays target the most recent
        // turns first when the user reopens a stale session detail.
        var i = state.entries.count - 1
        while i >= 0 {
            let e = state.entries[i]
            if e.eventType == "output",
               e.isComplete,
               e.turnID == turnID,
               (e.senderActorID ?? "") == bucket {
                return i
            }
            i -= 1
        }
        return nil
    }
}
