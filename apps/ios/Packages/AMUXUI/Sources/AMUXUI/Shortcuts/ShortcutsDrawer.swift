import SwiftUI
import AMUXCore
import AMUXSharedUI

public struct ShortcutsDrawer: View {
    @Binding var isPresented: Bool
    @Bindable var store: ShortcutsStore
    let onOpenSettings: () -> Void

    @State private var expandedIDs: Set<String> = []
    @State private var presentedLink: ShortcutLinkPresentation?

    public init(isPresented: Binding<Bool>,
                store: ShortcutsStore,
                onOpenSettings: @escaping () -> Void) {
        self._isPresented = isPresented
        self.store = store
        self.onOpenSettings = onOpenSettings
    }

    public var body: some View {
        GeometryReader { geometry in
            let drawerWidth = min(360, geometry.size.width * 0.86)
            ZStack(alignment: .leading) {
                if isPresented {
                    Color.amux.onyx
                        .opacity(0.22)
                        .ignoresSafeArea()
                        .onTapGesture { close() }
                        .transition(.opacity)

                    drawer(width: drawerWidth)
                        .transition(.move(edge: .leading))
                        .gesture(closeDrag)
                        .zIndex(1)
                }
            }
            .animation(.spring(response: 0.42, dampingFraction: 0.86), value: isPresented)
        }
        .fullScreenCover(item: $presentedLink) { link in
            ShortcutWebScreen(title: link.title, url: link.url) {
                presentedLink = nil
            }
        }
    }

    private func drawer(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            content
            settingsFooter
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.amux.mist)
        .ignoresSafeArea(edges: [.leading, .bottom])
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                section(title: "Personal", scope: .personal)
                section(title: "Team", scope: .team)

                if let err = store.errorMessage {
                    Text(err)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.horizontal, 24)
                        .padding(.top, 4)
                }
            }
            .padding(.top, 36)
            .padding(.bottom, 16)
        }
        .background(Color.amux.mist)
        .refreshable {
            await store.reload()
        }
        .task {
            await store.reload()
        }
        .overlay {
            if store.isLoading && allRootNodesAreEmpty {
                ProgressView().tint(Color.amux.basalt)
            } else if allRootNodesAreEmpty {
                emptyState
                    .padding(24)
            }
        }
    }

    private var settingsFooter: some View {
        HaiPaperCard {
            Button(action: handleSettingsTap) {
                HStack(spacing: 12) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(Color.amux.basalt)
                        .frame(width: 18, alignment: .center)

                    Text("Settings")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.amux.onyx)

                    Spacer(minLength: 6)
                }
                .padding(.vertical, 11)
                .padding(.horizontal, 14)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("shortcuts.settingsButton")
            .accessibilityLabel("Settings")
        }
        .padding(.top, 8)
        .padding(.bottom, 12)
        .background(Color.amux.mist)
    }

    private func section(title: String, scope: ShortcutScope) -> some View {
        let roots = store.children(parentID: nil, scope: scope)
        return Group {
            if !roots.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    sectionHeader(title: title, count: roots.count)
                    HaiPaperCard {
                        VStack(spacing: 0) {
                            ForEach(Array(roots.enumerated()), id: \.element.id) { idx, node in
                                if idx > 0 {
                                    Divider()
                                        .background(Color.amux.hairline)
                                        .padding(.leading, 14 + 18 + 12)
                                }
                                ShortcutMenuRow(
                                    node: node,
                                    store: store,
                                    depth: 0,
                                    expandedIDs: $expandedIDs,
                                    onSelectLink: { url, title in
                                        presentedLink = ShortcutLinkPresentation(url: url, title: title)
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private func sectionHeader(title: String, count: Int) -> some View {
        Text("\(title.uppercased()) · \(count)")
            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            .tracking(0.4)
            .foregroundStyle(Color.amux.slate)
            .padding(.horizontal, 24)
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No Shortcuts",
            systemImage: "star",
            description: Text("Shortcuts you or your team create will appear here.")
        )
        .foregroundStyle(Color.amux.basalt)
    }

    private var allRootNodesAreEmpty: Bool {
        store.children(parentID: nil, scope: .personal).isEmpty
            && store.children(parentID: nil, scope: .team).isEmpty
    }

    private var closeDrag: some Gesture {
        DragGesture(minimumDistance: 16)
            .onEnded { value in
                if value.translation.width < -56 || value.predictedEndTranslation.width < -120 {
                    close()
                }
            }
    }

    private func close() {
        isPresented = false
    }

    /// Close the drawer first, then ask the host to present SettingsView on the
    /// next runloop tick. Presenting the sheet from inside the drawer would
    /// tear it down on dismiss; routing through the host keeps the sheet alive
    /// even after the drawer animates away.
    private func handleSettingsTap() {
        close()
        DispatchQueue.main.async {
            onOpenSettings()
        }
    }
}

struct ShortcutLinkPresentation: Identifiable, Equatable {
    let id: String
    let url: URL
    let title: String

    init(url: URL, title: String) {
        self.id = url.absoluteString
        self.url = url
        self.title = title
    }
}
