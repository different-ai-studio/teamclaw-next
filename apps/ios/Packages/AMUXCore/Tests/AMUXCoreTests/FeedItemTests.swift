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
