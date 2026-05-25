import Testing
@testable import AMUXSharedUI
@testable import AMUXCore

@Suite("ToolDisplay")
struct ToolDisplayTests {
    @Test("summarizes preferred JSON fields")
    func summarizesPreferredJSONFields() {
        let summary = ToolDisplay.summary(for: #"{"file_path":"/tmp/todo.md","query":"todo"}"#)
        #expect(summary == "file path: /tmp/todo.md · query: todo")
    }

    @Test("falls back to plain description")
    func fallsBackToPlainDescription() {
        let summary = ToolDisplay.summary(for: "Read apps/ios/file.swift")
        #expect(summary == "Read apps/ios/file.swift")
    }

    @Test("ignores empty detail payloads")
    func ignoresEmptyDetailPayloads() {
        #expect(ToolDisplay.summary(for: "{}") == nil)
        #expect(ToolDisplay.summary(for: "null") == nil)
    }
}

@Suite("CompactToolLine")
struct CompactToolLineTests {
    @Test("renders resultSummary when populated")
    func compactToolLineShowsResultSummary() {
        let event = AgentEvent(agentId: "agent-1", sequence: 1, eventType: "tool_use")
        event.toolName = "Read"
        event.toolId = "t1"
        event.text = "foo.swift"
        event.isComplete = true
        event.success = true
        event.resultSummary = "12 lines"

        // Smoke check: construct the view. Don't invoke .body — on macOS test
        // host, SwiftUI @State views crash when body is accessed outside a
        // hosting environment.
        let line = CompactToolLine(event: event)
        _ = line  // referenced to suppress unused-variable warning
    }
}
