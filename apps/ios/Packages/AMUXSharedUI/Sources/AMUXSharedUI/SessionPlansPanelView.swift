import SwiftUI
import AMUXCore

/// Top-anchored liquid-glass panel showing the live plan_update snapshot
/// for each agent in the current session that still has unfinished
/// items. Multiple agents swipe horizontally via TabView's page style.
/// Mounted by `SessionDetailView` via `safeAreaInset(edge: .top)` so the
/// scroll content respects the panel's height instead of disappearing
/// behind it.
public struct SessionPlansPanelView: View {
    public let snapshots: [AgentPlanSnapshot]
    @Binding public var pageIndex: Int

    public init(snapshots: [AgentPlanSnapshot], pageIndex: Binding<Int>) {
        self.snapshots = snapshots
        self._pageIndex = pageIndex
    }

    public var body: some View {
        TabView(selection: $pageIndex) {
            ForEach(Array(snapshots.enumerated()), id: \.element.id) { idx, snapshot in
                SessionPlansPage(snapshot: snapshot).tag(idx)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: snapshots.count > 1 ? .always : .never))
        .frame(height: 280)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 22), interactive: false)
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .transition(.move(edge: .top).combined(with: .opacity))
        .onChange(of: snapshots.count) { _, newCount in
            // Keep the page binding in range when an agent's plan
            // completes and its page disappears.
            if pageIndex >= newCount {
                pageIndex = max(0, newCount - 1)
            }
        }
    }
}

private struct SessionPlansPage: View {
    let snapshot: AgentPlanSnapshot

    private var completedCount: Int {
        snapshot.items.filter { $0.status == .completed }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("\(snapshot.agentName) — Plans")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(completedCount) / \(snapshot.items.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(snapshot.items.enumerated()), id: \.offset) { index, item in
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
                                .foregroundStyle(
                                    item.status == .completed
                                        ? AnyShapeStyle(.secondary)
                                        : AnyShapeStyle(.primary)
                                )
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(.bottom, 24) // leave room for the page dots
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
    }

    private func icon(for status: TodoItemStatus) -> String {
        switch status {
        case .completed: "checkmark.circle.fill"
        case .inProgress: "circle.lefthalf.filled"
        case .pending: "circle"
        case .cancelled: "xmark.circle"
        }
    }

    private func color(for status: TodoItemStatus) -> Color {
        switch status {
        case .completed: Color.amux.sage
        case .inProgress: Color.amux.cinnabar
        case .pending, .cancelled: .secondary
        }
    }
}
