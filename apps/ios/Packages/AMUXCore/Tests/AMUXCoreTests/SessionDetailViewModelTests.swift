import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class SessionDetailViewModelTests: XCTestCase {
    func testStartPrunesPersistedSameAgentOutputPrefixDuplicate() async throws {
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        context.insert(session)

        let full = AgentEvent(agentId: "session-1", sequence: 41, eventType: "output")
        full.senderActorID = "agent-1"
        full.text = "I found the existing iOS pieces:\n- CreateIdeaSheet\n- AttachmentUploadManager"
        full.isComplete = true
        full.supabaseMessageId = "sb-full"
        full.turnID = "turn-1"
        full.timestamp = Date(timeIntervalSince1970: 1)
        context.insert(full)

        let prefix = AgentEvent(agentId: "session-1", sequence: 640, eventType: "output")
        prefix.senderActorID = "agent-1"
        prefix.text = "I found the existing iOS pieces:"
        prefix.isComplete = true
        prefix.timestamp = Date(timeIntervalSince1970: 2)
        context.insert(prefix)
        try context.save()

        let mqtt = MQTTService()
        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamclawService: nil
        )

        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        XCTAssertEqual(viewModel.events.filter { $0.eventType == "output" }.count, 1)
        XCTAssertEqual(viewModel.events.first?.text, full.text)
        XCTAssertEqual(viewModel.events.first?.supabaseMessageId, "sb-full")
    }

    func testSessionPromptUsesSessionLiveTransportEvenWithPlaceholderRuntime() async throws {
        var published: [(String, Data, Bool)] = []
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                published.append((topic, payload, retain))
            }
        )
        let teamclawService = TeamclawService()
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamclawService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamclawService.setLocalMemberIdForTesting("human-1")

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"
        let placeholder = Runtime(runtimeId: "agent-actor-1")
        placeholder.daemonDeviceId = "daemon-device-1"

        let viewModel = SessionDetailViewModel(
            runtime: placeholder,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamclawService: teamclawService
        )

        try await viewModel.sendPrompt("second turn")
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(
            published.first?.0,
            MQTTTopics.sessionLive(teamID: "team-1", sessionID: "session-1")
        )
        XCTAssertFalse(published.first?.2 ?? true)
    }
}
