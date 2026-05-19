import SwiftUI
import AMUXCore
import AMUXSharedUI

struct ShortcutMenuRow: View {
    let node: ShortcutRecord
    let store: ShortcutsStore
    let depth: Int
    @Binding var expandedIDs: Set<String>
    let onSelectLink: (URL, String) -> Void

    private var isExpanded: Bool { expandedIDs.contains(node.id) }
    private var destination: ShortcutPresentation { ShortcutPresentation.destination(for: node) }
    private var indent: CGFloat { CGFloat(depth) * 16 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: handleTap) {
                rowLabel
            }
            .buttonStyle(ShortcutRowButtonStyle())
            .accessibilityIdentifier("shortcuts.row.\(node.id)")

            if isExpanded, node.type == .folder {
                let children = store.children(parentID: node.id, scope: node.scope)
                if children.isEmpty {
                    Text("Empty")
                        .font(.system(size: 11.5))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.leading, indent + 48)
                        .padding(.vertical, 2)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                } else {
                    VStack(spacing: 6) {
                        ForEach(children) { child in
                            ShortcutMenuRow(
                                node: child,
                                store: store,
                                depth: depth + 1,
                                expandedIDs: $expandedIDs,
                                onSelectLink: onSelectLink
                            )
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    private var rowLabel: some View {
        HStack(spacing: 10) {
            iconView

            VStack(alignment: .leading, spacing: 2) {
                Text(node.label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(rowDisabled ? Color.amux.slate : Color.amux.onyx)
                    .lineLimit(1)

                if node.type == .link, let host = URL(string: node.target)?.host {
                    Text(host)
                        .font(.system(size: 11, weight: .regular, design: .monospaced))
                        .foregroundStyle(Color.amux.slate)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 6)
            trailingGlyph
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 10)
        .padding(.leading, indent)
        .background(rowBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.amux.hairline, lineWidth: 0.5)
                .padding(.leading, indent)
        )
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var iconView: some View {
        let kind = IconKind.detect(node.icon)
        ZStack {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.amux.pebble.opacity(0.7))
            switch kind {
            case .emoji(let s):
                Text(s)
                    .font(.system(size: 17))
            case .symbol(let name):
                Image(systemName: name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(iconColor)
            case .none:
                Image(systemName: defaultSymbol)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(iconColor)
            }
        }
        .frame(width: 30, height: 30)
    }

    @ViewBuilder
    private var trailingGlyph: some View {
        switch destination {
        case .folder:
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.amux.slate)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
        case .web:
            Image(systemName: "arrow.up.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.amux.slate)
        case .disabled:
            EmptyView()
        }
    }

    private var rowBackground: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color.amux.paper)
            .padding(.leading, indent)
    }

    private var rowDisabled: Bool {
        if case .disabled = destination { return true }
        return false
    }

    private var iconColor: Color {
        switch node.type {
        case .folder: return Color.amux.basalt
        case .link:   return Color.amux.onyx
        case .native: return Color.amux.slate
        }
    }

    private var defaultSymbol: String {
        switch node.type {
        case .folder: return "folder"
        case .link:   return "link"
        case .native: return "app"
        }
    }

    private func handleTap() {
        switch destination {
        case .folder:
            withAnimation(.spring(response: 0.32, dampingFraction: 0.84)) {
                if expandedIDs.contains(node.id) {
                    expandedIDs.remove(node.id)
                } else {
                    expandedIDs.insert(node.id)
                }
            }
        case .web(let url):
            onSelectLink(url, node.label)
        case .disabled:
            break
        }
    }
}

private struct ShortcutRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1.0)
            .scaleEffect(configuration.isPressed ? 0.985 : 1.0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

enum IconKind {
    case emoji(String)
    case symbol(String)
    case none

    static func detect(_ value: String?) -> IconKind {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return .none
        }
        let symbolAllowed = CharacterSet.alphanumerics
            .union(CharacterSet(charactersIn: ".-_"))
        if raw.unicodeScalars.allSatisfy({ symbolAllowed.contains($0) }) {
            return .symbol(raw)
        }
        return .emoji(raw)
    }
}
