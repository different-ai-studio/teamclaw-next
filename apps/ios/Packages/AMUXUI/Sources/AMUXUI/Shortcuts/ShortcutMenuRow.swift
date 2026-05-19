import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Plain shortcut row used inside a `HaiPaperCard`. The card and the
/// hairline separators between siblings live in the parent, so each row
/// renders as a bare HStack — no per-row background, no stroke, no
/// icon container. Restraint per DESIGN.md "不足の美".
struct ShortcutMenuRow: View {
    let node: ShortcutRecord
    let store: ShortcutsStore
    let depth: Int
    @Binding var expandedIDs: Set<String>
    let onSelectLink: (URL, String) -> Void

    private var isExpanded: Bool { expandedIDs.contains(node.id) }
    private var destination: ShortcutPresentation { ShortcutPresentation.destination(for: node) }
    private var indent: CGFloat { CGFloat(depth) * 18 }

    var body: some View {
        VStack(spacing: 0) {
            Button(action: handleTap) {
                rowLabel
            }
            .buttonStyle(ShortcutRowButtonStyle())
            .accessibilityIdentifier("shortcuts.row.\(node.id)")

            if isExpanded, node.type == .folder {
                let children = store.children(parentID: node.id, scope: node.scope)
                if children.isEmpty {
                    HStack {
                        Text("Empty")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.amux.slate)
                        Spacer()
                    }
                    .padding(.leading, indent + 30)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 14)
                    .transition(.opacity)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(children.enumerated()), id: \.element.id) { idx, child in
                            if idx > 0 {
                                Divider()
                                    .background(Color.amux.hairline)
                                    .padding(.leading, 14 + CGFloat(depth + 1) * 18 + 26)
                            }
                            ShortcutMenuRow(
                                node: child,
                                store: store,
                                depth: depth + 1,
                                expandedIDs: $expandedIDs,
                                onSelectLink: onSelectLink
                            )
                        }
                    }
                    .transition(.opacity)
                }
            }
        }
    }

    private var rowLabel: some View {
        HStack(spacing: 12) {
            iconView
                .padding(.leading, indent)

            Text(node.label)
                .font(.system(size: 15))
                .foregroundStyle(rowDisabled ? Color.amux.slate : Color.amux.onyx)
                .lineLimit(1)

            Spacer(minLength: 6)
            trailingGlyph
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 14)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var iconView: some View {
        let kind = IconKind.detect(node.icon)
        switch kind {
        case .emoji(let s):
            Text(s)
                .font(.system(size: 16))
                .frame(width: 18, alignment: .center)
        case .symbol(let name):
            Image(systemName: name)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(iconColor)
                .frame(width: 18, alignment: .center)
        case .none:
            Image(systemName: defaultSymbol)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(iconColor)
                .frame(width: 18, alignment: .center)
        }
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

    private var rowDisabled: Bool {
        if case .disabled = destination { return true }
        return false
    }

    private var iconColor: Color {
        switch node.type {
        case .folder: return Color.amux.basalt
        case .link:   return Color.amux.basalt
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
            withAnimation(.easeInOut(duration: 0.22)) {
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
            .background(configuration.isPressed ? Color.amux.onyx.opacity(0.04) : Color.clear)
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
