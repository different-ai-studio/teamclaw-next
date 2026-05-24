import Foundation

/// Pure formatter for the agent button label in `SessionComposer` Row 2.
/// Lives in AMUXCore so it can be unit-tested via `pnpm ios:test:core`.
public enum AgentButtonLabel {
    /// Returns nil when no agents are selected — the button renders icon-only.
    /// Returns just the first name when exactly one agent is selected.
    /// Returns "firstName ×N" when N > 1 agents are selected.
    /// The × is U+00D7 MULTIPLICATION SIGN.
    public static func text(
        selectedDisplayNamesInOrder names: [String],
        totalSelected: Int
    ) -> String? {
        guard totalSelected > 0, let first = names.first else { return nil }
        if totalSelected == 1 { return first }
        return "\(first) \u{00D7}\(totalSelected)"
    }
}
