# iOS Todo Dock + Slash Command Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move iOS todo rendering from the main chat feed into a sticky, collapsible dock at the bottom of the per-turn message-detail view, and render slash-command user prompts (`/foo …`) with a chip pill inside the user bubble.

**Architecture:** Consumer-side only. ACP event flow, `ChatTimelineReducer`, `TimelineState`, and SwiftData persistence are unchanged. `SessionDetailViewModel` gains one derived property (`latestTodoText`) that reads from the existing `events` array. Two new leaf views (`TodoDockView`, `CommandChip`) and two new pure parsers (`parseTodoText`, `extractSlashCommand`) land in `AMUXSharedUI`. `StreamingDetailView` mounts the dock via `safeAreaInset(.bottom)`; `EventBubbleView` user-bubble code path detects slash commands and renders the chip + remainder layout. `FeedItem.todo` and the old `TodoListView` are removed.

**Tech Stack:** Swift 6.2, SwiftUI, Swift Testing framework (`import Testing`), SwiftData, AMUXCore / AMUXSharedUI / AMUXUI SwiftPM packages.

**Spec:** `docs/superpowers/specs/2026-05-16-ios-todo-and-slash-command-design.md`

---

## File Structure

**New files (3):**
- `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift` — `TodoItemStatus` enum, `TodoItem` struct, `parseTodoText` parser, `TodoDockView` SwiftUI view.
- `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift` — `extractSlashCommand` parser, `CommandChip` SwiftUI view.
- `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/TodoDockParsingTests.swift` and `CommandChipParsingTests.swift` — Swift Testing unit tests for the pure parsers.

**Modified files (5):**
- `apps/ios/Packages/AMUXSharedUI/Package.swift` — add test target.
- `apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift` — add `latestTodoText` computed property.
- `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift` — drop `.todo` enum case + `buildFeedItems` arm.
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift` — replace `Text` in user bubbles with chip+remainder; remove orphan `case "todo_update"` arm.
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/SessionDetailView.swift` — drop `.todo` from `feedItemRow` switch.
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/StreamingDetailView.swift` — mount dock via `safeAreaInset` + auto-collapse task.

**Deleted files (1):**
- `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoListView.swift` — replaced by `TodoDockView`.

---

## Task 1: Add test target to AMUXSharedUI

**Files:**
- Modify: `apps/ios/Packages/AMUXSharedUI/Package.swift`

- [ ] **Step 1: Create test directory**

Run:
```bash
mkdir -p apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests
```

- [ ] **Step 2: Add testTarget to Package.swift**

Replace the `targets:` block in `apps/ios/Packages/AMUXSharedUI/Package.swift` so the array contains both the existing target and a new test target. The full new `targets:` value:

```swift
    targets: [
        .target(
            name: "AMUXSharedUI",
            dependencies: [
                "AMUXCore",
                .product(name: "Markdown", package: "swift-markdown"),
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
            ]
        ),
        .testTarget(
            name: "AMUXSharedUITests",
            dependencies: ["AMUXSharedUI"]
        ),
    ]
```

- [ ] **Step 3: Add a placeholder test so the target compiles**

Create `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/SmokeTest.swift`:

```swift
import Testing
@testable import AMUXSharedUI

@Test("AMUXSharedUITests target compiles and runs")
func smoke() {
    #expect(true)
}
```

- [ ] **Step 4: Resolve packages and run the smoke test**

Run:
```bash
cd apps/ios/Packages/AMUXSharedUI && swift test --filter SmokeTest
```

Expected: `Test smoke() passed`. Resolves the new test target wiring.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Packages/AMUXSharedUI/Package.swift apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/SmokeTest.swift
git commit -m "build(ios): add AMUXSharedUITests target"
```

---

## Task 2: `parseTodoText` parser + types (TDD)

**Files:**
- Create: `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift`
- Create: `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/TodoDockParsingTests.swift`

- [ ] **Step 1: Write failing tests**

Create `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/TodoDockParsingTests.swift`:

```swift
import Testing
@testable import AMUXSharedUI

@Suite("parseTodoText")
struct TodoDockParsingTests {
    @Test("empty text → empty array")
    func emptyText() {
        #expect(parseTodoText("") == [])
    }

    @Test("[done] prefix → .completed")
    func donePrefix() {
        let items = parseTodoText("[done] First item")
        #expect(items.count == 1)
        #expect(items[0].status == .completed)
        #expect(items[0].content == "First item")
    }

    @Test("[wip] prefix → .inProgress")
    func wipPrefix() {
        let items = parseTodoText("[wip] Second item")
        #expect(items[0].status == .inProgress)
        #expect(items[0].content == "Second item")
    }

    @Test("[todo] prefix → .pending")
    func todoPrefix() {
        let items = parseTodoText("[todo] Third item")
        #expect(items[0].status == .pending)
        #expect(items[0].content == "Third item")
    }

    @Test("[cancelled] prefix → .cancelled")
    func cancelledPrefix() {
        let items = parseTodoText("[cancelled] Fourth item")
        #expect(items[0].status == .cancelled)
        #expect(items[0].content == "Fourth item")
    }

    @Test("unknown prefix → .pending with raw line as content")
    func unknownPrefix() {
        let items = parseTodoText("just text no prefix")
        #expect(items.count == 1)
        #expect(items[0].status == .pending)
        #expect(items[0].content == "just text no prefix")
    }

    @Test("multiline input → one item per line, status preserved")
    func multilineMixed() {
        let text = """
        [done] One
        [wip] Two
        [todo] Three
        [cancelled] Four
        """
        let items = parseTodoText(text)
        #expect(items.count == 4)
        #expect(items.map(\.status) == [.completed, .inProgress, .pending, .cancelled])
        #expect(items.map(\.content) == ["One", "Two", "Three", "Four"])
    }

    @Test("trailing whitespace on content is trimmed")
    func trailingWhitespaceTrimmed() {
        let items = parseTodoText("[done] Trimmed   ")
        #expect(items[0].content == "Trimmed")
    }

    @Test("blank lines are skipped")
    func blankLinesSkipped() {
        let text = "[done] One\n\n[wip] Two\n"
        let items = parseTodoText(text)
        #expect(items.count == 2)
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
cd apps/ios/Packages/AMUXSharedUI && swift test --filter TodoDockParsingTests
```

Expected: compilation error — `parseTodoText`, `TodoItem`, `TodoItemStatus` undefined.

- [ ] **Step 3: Implement types and parser**

Create `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift`:

```swift
import SwiftUI

// MARK: - Public types

public enum TodoItemStatus: Sendable, Equatable {
    case pending
    case inProgress
    case completed
    case cancelled
}

public struct TodoItem: Sendable, Equatable {
    public let content: String
    public let status: TodoItemStatus

    public init(content: String, status: TodoItemStatus) {
        self.content = content
        self.status = status
    }
}

// MARK: - Parser

/// Parse the daemon's todo_update text payload into structured items.
/// Each non-empty line maps to one `TodoItem`. Recognized prefixes:
///   - `[done] foo`       → .completed
///   - `[wip] foo`        → .inProgress
///   - `[todo] foo`       → .pending
///   - `[cancelled] foo`  → .cancelled
/// Lines without a recognized prefix become `.pending` with the raw
/// line (trimmed) as content. Blank lines are skipped.
public func parseTodoText(_ text: String) -> [TodoItem] {
    text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { rawLine in
        let line = String(rawLine).trimmingCharacters(in: .whitespaces)
        if line.isEmpty { return nil }

        if let stripped = line.stripping(prefix: "[done]") {
            return TodoItem(content: stripped, status: .completed)
        }
        if let stripped = line.stripping(prefix: "[wip]") {
            return TodoItem(content: stripped, status: .inProgress)
        }
        if let stripped = line.stripping(prefix: "[todo]") {
            return TodoItem(content: stripped, status: .pending)
        }
        if let stripped = line.stripping(prefix: "[cancelled]") {
            return TodoItem(content: stripped, status: .cancelled)
        }
        return TodoItem(content: line, status: .pending)
    }
}

private extension String {
    /// Returns the substring after `prefix`, trimmed of surrounding
    /// whitespace, or nil if `self` does not start with `prefix`.
    func stripping(prefix: String) -> String? {
        guard hasPrefix(prefix) else { return nil }
        return String(dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd apps/ios/Packages/AMUXSharedUI && swift test --filter TodoDockParsingTests
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/TodoDockParsingTests.swift
git commit -m "feat(ios): add TodoItem types + parseTodoText parser"
```

---

## Task 3: `TodoDockView` SwiftUI component

**Files:**
- Modify: `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift`

SwiftUI view rendering is verified by build + visual inspection (no unit test); type signatures are checked by compiler.

- [ ] **Step 1: Append the dock view to the file**

Append to `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift`:

```swift
// MARK: - TodoDockView

/// Sticky bottom dock rendering the latest todo snapshot for the current
/// session. Mounted via `safeAreaInset(.bottom)` on `StreamingDetailView`.
/// Returns an empty view when there are no items so the safe-area inset
/// reserves no space.
public struct TodoDockView: View {
    public let text: String
    @Binding public var isCollapsed: Bool

    public init(text: String, isCollapsed: Binding<Bool>) {
        self.text = text
        self._isCollapsed = isCollapsed
    }

    private var items: [TodoItem] { parseTodoText(text) }
    private var completedCount: Int { items.filter { $0.status == .completed }.count }

    public var body: some View {
        if items.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 0) {
                header
                if !isCollapsed {
                    list
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 8)
            .animation(.easeInOut(duration: 0.2), value: isCollapsed)
        }
    }

    private var header: some View {
        Button {
            isCollapsed.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checklist")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(items.count) tasks · \(completedCount) done")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isCollapsed ? 0 : 180))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(index + 1).")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(width: 20, alignment: .trailing)
                        Image(systemName: icon(for: item.status))
                            .font(.caption)
                            .foregroundStyle(color(for: item.status))
                            .padding(.top, 3)
                        Text(item.content)
                            .font(.subheadline)
                            .strikethrough(item.status == .completed)
                            .foregroundStyle(item.status == .completed ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 10)
        }
        .frame(maxHeight: 175)
    }

    private func icon(for status: TodoItemStatus) -> String {
        switch status {
        case .completed: "checkmark.circle.fill"
        case .inProgress: "clock"
        case .pending: "circle"
        case .cancelled: "xmark.circle"
        }
    }

    private func color(for status: TodoItemStatus) -> Color {
        switch status {
        case .completed: .green
        case .inProgress: .blue
        case .pending, .cancelled: .secondary
        }
    }
}
```

- [ ] **Step 2: Build AMUXSharedUI to confirm compile**

Run:
```bash
cd apps/ios/Packages/AMUXSharedUI && swift build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift
git commit -m "feat(ios): add TodoDockView SwiftUI component"
```

---

## Task 4: `extractSlashCommand` parser (TDD)

**Files:**
- Create: `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift`
- Create: `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/CommandChipParsingTests.swift`

- [ ] **Step 1: Write failing tests**

Create `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/CommandChipParsingTests.swift`:

```swift
import Testing
@testable import AMUXSharedUI

@Suite("extractSlashCommand")
struct CommandChipParsingTests {
    @Test("plain command with arguments → split")
    func commandWithArgs() {
        let result = extractSlashCommand("/cmd args here")
        #expect(result?.command == "cmd")
        #expect(result?.rest == "args here")
    }

    @Test("bare command (no args) → empty rest")
    func commandNoArgs() {
        let result = extractSlashCommand("/cmd")
        #expect(result?.command == "cmd")
        #expect(result?.rest == "")
    }

    @Test("command with dash → matches")
    func commandWithDash() {
        let result = extractSlashCommand("/plan-ceo-review now")
        #expect(result?.command == "plan-ceo-review")
        #expect(result?.rest == "now")
    }

    @Test("command with underscore → matches")
    func commandWithUnderscore() {
        let result = extractSlashCommand("/cmd_under value")
        #expect(result?.command == "cmd_under")
        #expect(result?.rest == "value")
    }

    @Test("digit start → nil")
    func digitStart() {
        #expect(extractSlashCommand("/123abc") == nil)
    }

    @Test("bare slash → nil")
    func bareSlash() {
        #expect(extractSlashCommand("/") == nil)
    }

    @Test("no leading slash → nil")
    func noLeadingSlash() {
        #expect(extractSlashCommand("not a command") == nil)
    }

    @Test("leading whitespace → nil")
    func leadingWhitespace() {
        #expect(extractSlashCommand(" /cmd") == nil)
    }

    @Test("multiline body → rest contains newlines")
    func multilineBody() {
        let result = extractSlashCommand("/cmd line one\nline two")
        #expect(result?.command == "cmd")
        #expect(result?.rest == "line one\nline two")
    }

    @Test("empty string → nil")
    func emptyString() {
        #expect(extractSlashCommand("") == nil)
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
cd apps/ios/Packages/AMUXSharedUI && swift test --filter CommandChipParsingTests
```

Expected: compile error — `extractSlashCommand` undefined.

- [ ] **Step 3: Implement the parser**

Create `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift`:

```swift
import SwiftUI

// MARK: - Parser

/// Detect a leading slash command in `text` and split into the command
/// name and any remaining body. Returns nil when `text` does not start
/// with `/<letter>[\w-]*` followed by whitespace, newline, or end-of-string.
///
/// Examples:
///   "/cmd args here" → ("cmd", "args here")
///   "/cmd"           → ("cmd", "")
///   "/123"           → nil   (must start with a letter)
///   "/"              → nil
///   " /cmd"          → nil   (no leading whitespace allowed)
///
/// Does NOT check membership against `availableCommands` — historical
/// messages may reference retired commands and should still chip-render.
public func extractSlashCommand(_ text: String) -> (command: String, rest: String)? {
    guard text.hasPrefix("/"), text.count > 1 else { return nil }

    let afterSlash = text.dropFirst()
    guard let first = afterSlash.first, first.isLetter else { return nil }

    // Collect command-name characters (letters, digits, _, -).
    var nameEnd = afterSlash.startIndex
    while nameEnd < afterSlash.endIndex {
        let ch = afterSlash[nameEnd]
        if ch.isLetter || ch.isNumber || ch == "_" || ch == "-" {
            nameEnd = afterSlash.index(after: nameEnd)
        } else {
            break
        }
    }
    let name = String(afterSlash[afterSlash.startIndex..<nameEnd])
    guard !name.isEmpty else { return nil }

    // Anything after the name must be whitespace/newline (or end-of-string).
    if nameEnd == afterSlash.endIndex {
        return (name, "")
    }
    let separator = afterSlash[nameEnd]
    guard separator.isWhitespace || separator.isNewline else { return nil }

    // Rest = everything after the first separator character.
    let restStart = afterSlash.index(after: nameEnd)
    let rest = String(afterSlash[restStart..<afterSlash.endIndex])
    return (name, rest)
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
cd apps/ios/Packages/AMUXSharedUI && swift test --filter CommandChipParsingTests
```

Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/CommandChipParsingTests.swift
git commit -m "feat(ios): add extractSlashCommand parser"
```

---

## Task 5: `CommandChip` SwiftUI component

**Files:**
- Modify: `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift`

- [ ] **Step 1: Append the view to the file**

Append to `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift`:

```swift
// MARK: - View

/// Small capsule pill rendered inside a user_prompt bubble when the
/// message begins with a slash command. The leading `/` is part of the
/// rendered text — no extra icon glyph — keeping the chip self-contained
/// without an extra leading slot.
public struct CommandChip: View {
    public let name: String
    /// Foreground color override. Defaults to .primary for use over neutral
    /// glass backgrounds; pass `Color.amux.mist` (or similar) when the chip
    /// sits inside a tinted bubble where the default would be unreadable.
    public let foreground: Color
    /// Background tint applied behind the chip via `liquidGlass`. Pass nil
    /// for the package's default glass treatment.
    public let backgroundTint: Color?

    public init(name: String,
                foreground: Color = .primary,
                backgroundTint: Color? = nil) {
        self.name = name
        self.foreground = foreground
        self.backgroundTint = backgroundTint
    }

    public var body: some View {
        Text("/\(name)")
            .font(.caption.monospaced().weight(.semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .modifier(CommandChipBackground(tint: backgroundTint))
    }
}

private struct CommandChipBackground: ViewModifier {
    let tint: Color?
    func body(content: Content) -> some View {
        if let tint {
            content.liquidGlass(in: Capsule(), tint: tint, interactive: false)
        } else {
            content.liquidGlass(in: Capsule(), interactive: false)
        }
    }
}
```

- [ ] **Step 2: Build AMUXSharedUI**

Run:
```bash
cd apps/ios/Packages/AMUXSharedUI && swift build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift
git commit -m "feat(ios): add CommandChip SwiftUI component"
```

---

## Task 6: Add `latestTodoText` to `SessionDetailViewModel`

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift`

- [ ] **Step 1: Find the insertion point**

Locate the `public var events: [AgentEvent] = []` declaration near the top of the class (line ~20). The new property goes right after `events` so it is co-located with the source data.

- [ ] **Step 2: Add the derived property**

Insert after `public var events: [AgentEvent] = []`:

```swift
    /// Latest todo_update snapshot text for this session, or nil when the
    /// session has never received a todo update. Source for the bottom
    /// dock on `StreamingDetailView`. The reducer keeps a single
    /// in-place-replaced todo_update entry in `events`, so `.last(where:)`
    /// returns the freshest one.
    public var latestTodoText: String? {
        events.last(where: { $0.eventType == "todo_update" })?.text
    }
```

- [ ] **Step 3: Build AMUXCore**

Run:
```bash
cd apps/ios/Packages/AMUXCore && swift build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift
git commit -m "feat(ios): add latestTodoText derived prop to SessionDetailViewModel"
```

---

## Task 7: Mount `TodoDockView` in `StreamingDetailView`

**Files:**
- Modify: `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/StreamingDetailView.swift`

- [ ] **Step 1: Add collapse state property**

In `StreamingDetailView`, after the `@Bindable var viewModel: SessionDetailViewModel` property, add:

```swift
    @State private var todoCollapsed: Bool = false
```

- [ ] **Step 2: Mount the dock via safeAreaInset**

The current outermost-view chain ends with `.toolbar { … }`. Append two modifiers after `.toolbar { … }` (and inside `public var body: some View { … }`):

```swift
        .safeAreaInset(edge: .bottom) {
            if let text = viewModel.latestTodoText {
                TodoDockView(text: text, isCollapsed: $todoCollapsed)
            }
        }
        .task(id: viewModel.latestTodoText) {
            guard let text = viewModel.latestTodoText else { return }
            let items = parseTodoText(text)
            let allDone = !items.isEmpty && items.allSatisfy { $0.status == .completed }
            todoCollapsed = allDone
        }
```

The `if let text = viewModel.latestTodoText` guard inside the inset closure ensures the safe-area reserves zero space when there is no todo for this session.

`task(id:)` fires once on appear AND on every change of `latestTodoText` — so the auto-collapse rule re-evaluates against the freshest text.

- [ ] **Step 3: Build AMUXUI**

Run:
```bash
cd apps/ios/Packages/AMUXUI && swift build
```

Expected: build succeeds. `TodoDockView` and `parseTodoText` are visible because `AMUXUI` already depends on `AMUXSharedUI`.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/StreamingDetailView.swift
git commit -m "feat(ios): mount TodoDockView in StreamingDetailView"
```

---

## Task 8: Render command chip in user bubbles

**Files:**
- Modify: `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift`

- [ ] **Step 1: Replace `selfUserBubble` inner Text**

Find `private var selfUserBubble: some View {` (~line 145). Replace the inner `Text(event.text ?? "")` block (lines ~162–173 — the `Text` along with its `.font/.foregroundStyle/.textSelection/.padding/.liquidGlass/.contextMenu` modifiers) with:

```swift
                    selfBubbleContent
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .liquidGlass(in: RoundedRectangle(cornerRadius: 18),
                                     tint: Color.amux.cinnabar,
                                     interactive: false)
                        .contextMenu {
                            MessageContextMenu(text: event.text ?? "")
                        }
```

Then add the new `@ViewBuilder` helper after the `selfUserBubble` property:

```swift
    @ViewBuilder
    private var selfBubbleContent: some View {
        if let parsed = extractSlashCommand(event.text ?? "") {
            VStack(alignment: .leading, spacing: 6) {
                CommandChip(
                    name: parsed.command,
                    foreground: Color.amux.mist,
                    backgroundTint: Color.amux.mist.opacity(0.25)
                )
                if !parsed.rest.isEmpty {
                    Text(parsed.rest)
                        .font(.subheadline)
                        .foregroundStyle(Color.amux.mist)
                        .textSelection(.enabled)
                }
            }
        } else {
            Text(event.text ?? "")
                .font(.subheadline)
                .foregroundStyle(Color.amux.mist)
                .textSelection(.enabled)
        }
    }
```

- [ ] **Step 2: Replace `otherUserBubble` inner Text**

Find `private var otherUserBubble: some View {` (~line 182). Replace the inner `Text(event.text ?? "")` block (the `Text` with its `.font/.foregroundStyle/.textSelection/.padding/.liquidGlass/.frame/.contextMenu` modifiers) with:

```swift
                otherBubbleContent
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
                    .frame(maxWidth: sizeClass == .regular ? 500 : 260, alignment: .leading)
                    .contextMenu {
                        MessageContextMenu(text: event.text ?? "")
                    }
```

Then add the helper after the `otherUserBubble` property:

```swift
    @ViewBuilder
    private var otherBubbleContent: some View {
        if let parsed = extractSlashCommand(event.text ?? "") {
            VStack(alignment: .leading, spacing: 6) {
                CommandChip(name: parsed.command)
                if !parsed.rest.isEmpty {
                    Text(parsed.rest)
                        .font(.subheadline)
                        .foregroundStyle(Color.amux.onyx)
                        .textSelection(.enabled)
                }
            }
        } else {
            Text(event.text ?? "")
                .font(.subheadline)
                .foregroundStyle(Color.amux.onyx)
                .textSelection(.enabled)
        }
    }
```

- [ ] **Step 3: Build AMUXUI**

Run:
```bash
cd apps/ios/Packages/AMUXUI && swift build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift
git commit -m "feat(ios): render command chip in user_prompt bubbles"
```

---

## Task 9: Remove `FeedItem.todo` from main feed

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift`
- Modify: `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift`
- Modify: `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/SessionDetailView.swift`
- Delete: `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoListView.swift`

This task lands the spec's three removals together because each is a compile-time dependency of the next.

- [ ] **Step 1: Drop the enum case + buildFeedItems arm**

In `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift`:

Delete lines around 33–34:
```swift
    /// Daemon-pushed todo snapshot for the current turn — kept in the
    /// main feed because users routinely scan it for plan progress.
    case todo(AgentEvent)
```

Delete the corresponding arm of `id` (around line 45):
```swift
        case .todo(let e): return "todo-\(e.id)"
```

In `buildFeedItems`, replace the `case "todo_update":` arm (around line 88-89):
```swift
        case "todo_update":
            result.append(.todo(event))
```
with:
```swift
        case "todo_update":
            continue
```

- [ ] **Step 2: Remove orphan switch arm in EventBubbleView**

In `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift`, find the body switch (around line 96) and delete the `case "todo_update":` arm:

```swift
        case "todo_update":
            TodoListView(text: event.text ?? "")
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
```

- [ ] **Step 3: Drop `.todo` from `feedItemRow` switch**

In `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/SessionDetailView.swift`, locate `private func feedItemRow(_ item: FeedItem)` (around line 347). Change:

```swift
        case .userMessage(let event), .permission(let event), .todo(let event), .error(let event):
```
to:
```swift
        case .userMessage(let event), .permission(let event), .error(let event):
```

- [ ] **Step 4: Delete the old TodoListView file**

Run:
```bash
rm apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoListView.swift
```

- [ ] **Step 5: Build all three packages**

Run:
```bash
cd apps/ios/Packages/AMUXCore && swift build
cd ../AMUXSharedUI && swift build
cd ../AMUXUI && swift build
```

Expected: all three succeed. If `AMUXUI` errors with `Cannot find 'TodoListView'`, an extra reference to the deleted view remained — grep and delete it:

```bash
cd ../../../../ && grep -rn "TodoListView" apps/ios/Packages/
```

- [ ] **Step 6: Run the AMUXCore test suite**

Run:
```bash
cd apps/ios/Packages/AMUXCore && swift test
```

Expected: all existing tests pass. None of the existing tests pattern-match on `FeedItem.todo`, so no test updates are needed (grep verified during planning).

- [ ] **Step 7: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/SessionDetailView.swift
git rm apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoListView.swift
git commit -m "refactor(ios): remove FeedItem.todo + legacy TodoListView"
```

---

## Task 10: Add coverage test for `buildFeedItems` skipping todo_update

**Files:**
- Modify: `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/` — find or create an appropriate test file

- [ ] **Step 1: Check whether a buildFeedItems test file exists**

Run:
```bash
grep -rln "buildFeedItems" apps/ios/Packages/AMUXCore/Tests/
```

If a file exists, append to it. Otherwise create:
`apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/FeedItemBuildTests.swift`.

- [ ] **Step 2: Add the test**

Place this in the chosen file (create if needed):

```swift
import Testing
import Foundation
@testable import AMUXCore

@Suite("buildFeedItems")
struct FeedItemBuildTests {
    @Test("todo_update events do not produce any FeedItem")
    func todoUpdateProducesNoFeedItem() {
        let event = AgentEvent(agentId: "a", sequence: 0, eventType: "todo_update")
        event.text = "[done] One\n[wip] Two"

        let items = buildFeedItems([event])

        #expect(items.isEmpty)
    }

    @Test("todo_update interleaved with user_prompt keeps the prompt")
    func todoUpdateDoesNotDropOtherEvents() {
        let todo = AgentEvent(agentId: "a", sequence: 0, eventType: "todo_update")
        todo.text = "[wip] Plan"
        let prompt = AgentEvent(agentId: "a", sequence: 1, eventType: "user_prompt")
        prompt.text = "hello"

        let items = buildFeedItems([todo, prompt])

        #expect(items.count == 1)
        if case .userMessage(let e) = items[0] {
            #expect(e.text == "hello")
        } else {
            Issue.record("Expected userMessage, got \(items[0])")
        }
    }
}
```

- [ ] **Step 3: Run the new tests**

Run:
```bash
cd apps/ios/Packages/AMUXCore && swift test --filter FeedItemBuildTests
```

Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/FeedItemBuildTests.swift
git commit -m "test(ios): cover buildFeedItems skipping todo_update"
```

---

## Task 11: Full-suite verification + manual smoke test

**Files:** none

- [ ] **Step 1: Run every iOS package test**

Run:
```bash
pnpm ios:test:core
```

Expected: green. (This wraps `swift test` across the AMUXCore/AMUXSharedUI/AMUXUI packages per the repo's `package.json` script — confirms no test regressions across the whole iOS surface.)

- [ ] **Step 2: Confirm there is no other reference to `FeedItem.todo` or `TodoListView`**

Run:
```bash
grep -rn "FeedItem.todo\|\.todo(let\|TodoListView" apps/ios/Packages/
```

Expected: no matches.

- [ ] **Step 3: Build and launch the iOS app on the booted simulator**

Run:
```bash
pnpm ios:run
```

Expected: app builds, installs, and launches. The script handles simulator boot and app install.

- [ ] **Step 4: Manual visual verification**

Use a session that has produced a todo and a slash-command user_prompt (e.g. `/plan-ceo-review`):

  1. **Main feed** — confirm the chat list shows no todo bubble. Slash-command user prompts show a monospaced `/cmd` chip pill at the top of the bubble; remaining body wraps below.
  2. **Tap a completed-turn detail icon (or an active stream card)** — push `StreamingDetailView`. Confirm the bottom dock appears with the latest todo, header reads `"N tasks · M done"`, and tapping the header toggles expand/collapse.
  3. **Mark all items done in the daemon** — the dock auto-collapses on the next push.
  4. **Add a new pending item** — dock auto-expands.
  5. **Navigate back to the session list** — no dock there (StreamingDetailView only).
  6. **Open a session with no todos** — dock does not appear in the detail view (no safe-area space reserved).

- [ ] **Step 5: Final commit if any docs need touchup**

If verification surfaces a fix, commit it as its own follow-up commit. No housekeeping commit if nothing changed.

---

## Self-Review Checklist (done during plan authoring)

- ✅ Spec sections covered:
  - "Data flow + latestTodoText" → Task 6
  - Todo dock visual → Tasks 2, 3
  - Todo dock collapse rule → Task 7
  - Slash command parser → Task 4
  - CommandChip view → Task 5
  - Chip rendering in selfUserBubble + otherUserBubble → Task 8
  - Remove `FeedItem.todo` + buildFeedItems arm → Task 9
  - Remove EventBubbleView todo arm → Task 9
  - Drop `.todo` from feedItemRow → Task 9
  - Delete TodoListView.swift → Task 9
  - Tests: parsers (Tasks 2, 4), buildFeedItems skip (Task 10)
- ✅ No placeholders / TODOs in steps; every code change shows the full code block.
- ✅ Type signatures consistent across tasks: `TodoItem.content/status`, `TodoItemStatus.{pending,inProgress,completed,cancelled}`, `extractSlashCommand(_:) -> (command: String, rest: String)?`, `CommandChip(name:foreground:backgroundTint:)`, `parseTodoText(_:) -> [TodoItem]`, `latestTodoText: String?` — all referenced consistently.
- ✅ Each task is ~2–5 minutes; TDD discipline (failing test → impl → pass → commit) preserved on the two pure-function tasks. UI tasks fall back to compile+visual verification since SwiftUI views aren't worth snapshot-testing for this scope.
