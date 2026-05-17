import SwiftUI
import AMUXCore

public struct ShortcutsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: ShortcutsStore

    public init(store: ShortcutsStore) {
        self.store = store
    }

    public var body: some View {
        NavigationStack {
            List {
                let personalRoots = store.children(parentID: nil, scope: .personal)
                let teamRoots     = store.children(parentID: nil, scope: .team)

                if personalRoots.isEmpty && teamRoots.isEmpty && !store.isLoading {
                    ContentUnavailableView(
                        "No Shortcuts",
                        systemImage: "star",
                        description: Text("Shortcuts you or your team create will appear here.")
                    )
                }

                if !personalRoots.isEmpty {
                    Section("Personal") {
                        ForEach(personalRoots) { node in
                            ShortcutRow(node: node, store: store)
                        }
                    }
                }
                if !teamRoots.isEmpty {
                    Section("Team") {
                        ForEach(teamRoots) { node in
                            ShortcutRow(node: node, store: store)
                        }
                    }
                }
            }
            .navigationTitle("Shortcuts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable {
                await store.reload()
            }
            .task {
                await store.reload()
            }
            .overlay {
                if let err = store.errorMessage {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 12)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
            }
        }
    }
}
