import SwiftUI
import AMUXCore

/// Inline autocomplete card for `@`-mentions. Shows session humans and
/// agents in a single visually-grouped list. Tapping a row passes the
/// `MentionTarget` back to the parent which decides what to do with it
/// (members → inline `@name` token in the body, agents → add a removable
/// chip above the composer).
public struct MentionsPopup: View {
    let candidates: [MentionTarget]
    let onTap: (MentionTarget) -> Void

    public init(candidates: [MentionTarget],
                onTap: @escaping (MentionTarget) -> Void) {
        self.candidates = candidates
        self.onTap = onTap
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(candidates) { target in
                Button {
                    onTap(target)
                } label: {
                    MentionRow(target: target)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(target.kind == .agent ? "agent \(target.displayName)" : "member \(target.displayName)"))

                if target.id != candidates.last?.id {
                    Divider()
                        .padding(.leading, 44)
                        .opacity(0.4)
                }
            }
        }
        .padding(.vertical, 4)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(.separator.opacity(0.35), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
}

private struct MentionRow: View {
    let target: MentionTarget

    var body: some View {
        HStack(spacing: 10) {
            avatar
            VStack(alignment: .leading, spacing: 1) {
                Text(target.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let subtitle = target.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 36)
        .contentShape(Rectangle())
    }

    private var avatar: some View {
        ZStack {
            Circle()
                .fill(avatarBackground)
                .frame(width: 24, height: 24)
            Image(systemName: target.kind == .agent ? "sparkles" : "person.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(avatarForeground)
        }
    }

    private var avatarBackground: AnyShapeStyle {
        switch target.kind {
        case .member: AnyShapeStyle(Color.secondary.opacity(0.18))
        case .agent:  AnyShapeStyle(Color.orange.opacity(0.22))
        }
    }

    private var avatarForeground: Color {
        switch target.kind {
        case .member: .secondary
        case .agent:  .orange
        }
    }

}

#Preview {
    VStack {
        Spacer()
        MentionsPopup(
            candidates: [
                MentionTarget(id: "1", displayName: "matt", subtitle: "Member", kind: .member),
                MentionTarget(id: "2", displayName: "macmini-simulator", subtitle: "Member", kind: .member),
                MentionTarget(id: "3", displayName: "mini", subtitle: "Claude · idle", kind: .agent),
                MentionTarget(id: "4", displayName: "swarm-1", subtitle: "OpenCode · running", kind: .agent),
            ],
            onTap: { _ in }
        )
        .padding(.horizontal, 16)
        Spacer()
    }
    .background(Color.gray.opacity(0.25))
}
