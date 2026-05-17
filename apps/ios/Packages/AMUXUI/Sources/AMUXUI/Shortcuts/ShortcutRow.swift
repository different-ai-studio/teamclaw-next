import SwiftUI
import AMUXCore

struct ShortcutRow: View {
    let node: ShortcutRecord
    let store: ShortcutsStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        switch node.type {
        case .folder:
            DisclosureGroup {
                ForEach(store.children(parentID: node.id, scope: node.scope)) { child in
                    ShortcutRow(node: child, store: store)
                }
            } label: {
                rowLabel
            }
        case .link:
            Button {
                if let url = URL(string: node.target) { openURL(url) }
            } label: {
                rowLabel
            }
            .buttonStyle(.plain)
            .disabled(URL(string: node.target) == nil)
        case .native:
            rowLabel.foregroundStyle(.secondary)
        }
    }

    private var rowLabel: some View {
        Label {
            Text(node.label)
        } icon: {
            Image(systemName: node.icon ?? defaultIcon)
                .foregroundStyle(.tint)
        }
    }

    private var defaultIcon: String {
        switch node.type {
        case .folder: return "folder.fill"
        case .link:   return "link.circle"
        case .native: return "app"
        }
    }
}
