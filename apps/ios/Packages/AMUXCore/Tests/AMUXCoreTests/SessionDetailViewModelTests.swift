import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class SessionDetailViewModelTests: XCTestCase {
    private actor PublishedMessages {
        private(set) var value: [(String, Data, Bool)] = []

        func append(_ message: (String, Data, Bool)) {
            value.append(message)
        }
    }

    private func makeAgent(actorID: String, runtimeID: String?) -> MemberSheetAgent {
        MemberSheetAgent(
            id: actorID,
            displayName: actorID,
            workspacePath: "",
            agentType: "Claude",
            runtimeState: .ready,
            availableModels: [],
            currentModel: nil,
            runtimeID: runtimeID,
            workspaceID: nil,
            backendType: "claude"
        )
    }

    func testSessionPromptUsesSessionLiveTransportEvenWithPlaceholderRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
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

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertEqual(
            snapshot.first?.0,
            MQTTTopics.sessionLive(teamID: "team-1", sessionID: "session-1")
        )
        XCTAssertFalse(snapshot.first?.2 ?? true)
    }

    func testGrantPermissionRoutesToPermissionSourceRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-primary"
        let primaryRuntime = Runtime(runtimeId: "rt-primary")
        primaryRuntime.daemonDeviceId = "daemon-device-1"

        let viewModel = SessionDetailViewModel(
            runtime: primaryRuntime,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-primary", runtimeID: "rt-primary"),
            makeAgent(actorID: "agent-secondary", runtimeID: "rt-secondary")
        ])

        try await viewModel.grantPermission(requestId: "perm-1", agentActorID: "agent-secondary")

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        let (topic, data, retain) = try XCTUnwrap(snapshot.first)
        XCTAssertFalse(retain)
        XCTAssertEqual(
            topic,
            MQTTTopics.runtimeCommands(teamID: "team-1", deviceID: "daemon-device-1", runtimeID: "rt-secondary")
        )
        let envelope = try Amux_RuntimeCommandEnvelope(serializedBytes: data)
        XCTAssertEqual(envelope.runtimeID, "rt-secondary")
        if case .grantPermission(let grant) = envelope.acpCommand.command {
            XCTAssertEqual(grant.requestID, "perm-1")
        } else {
            XCTFail("expected grantPermission ACP command")
        }
    }

    func testGrantPermissionRoutesEvenWhenDetailRuntimeIsNil() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-secondary"
        context.insert(session)

        let secondaryRuntime = Runtime(runtimeId: "rt-secondary")
        secondaryRuntime.daemonDeviceId = "daemon-device-2"
        context.insert(secondaryRuntime)
        try context.save()

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-secondary", runtimeID: "rt-secondary")
        ])
        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        try await viewModel.grantPermission(requestId: "perm-2", agentActorID: "agent-secondary")

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        let (topic, data, retain) = try XCTUnwrap(snapshot.first)
        XCTAssertFalse(retain)
        XCTAssertEqual(
            topic,
            MQTTTopics.runtimeCommands(teamID: "team-1", deviceID: "daemon-device-2", runtimeID: "rt-secondary")
        )
        let envelope = try Amux_RuntimeCommandEnvelope(serializedBytes: data)
        XCTAssertEqual(envelope.runtimeID, "rt-secondary")
        if case .grantPermission(let grant) = envelope.acpCommand.command {
            XCTAssertEqual(grant.requestID, "perm-2")
        } else {
            XCTFail("expected grantPermission ACP command")
        }
    }
}
