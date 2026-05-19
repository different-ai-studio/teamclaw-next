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
        .clipShape(.rect(topLeadingRadius: 0, bottomLeadingRadius: 0, bottomTrailingRadius: 22, topTrailingRadius: 0))
        .shadow(color: Color.amux.onyx.opacity(0.14), radius: 22, x: 6, y: 0)
        .ignoresSafeArea(edges: [.leading, .bottom])
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                section(title: "Personal", scope: .personal)
                section(title: "Team", scope: .team)

                if let err = store.errorMessage {
                    Text(err)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.horizontal, 2)
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
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
        VStack(spacing: 0) {
            Rectangle()
                .fill(Color.amux.hairline)
                .frame(height: 0.5)

            Button(action: handleSettingsTap) {
                HStack(spacing: 10) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.amux.onyx)
                        .frame(width: 30, height: 30)
                        .background(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .fill(Color.amux.pebble.opacity(0.7))
                        )

                    Text("Settings")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.amux.onyx)

                    Spacer(minLength: 6)
                }
                .padding(.vertical, 9)
                .padding(.horizontal, 10)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.amux.paper)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(SettingsRowButtonStyle())
            .accessibilityIdentifier("shortcuts.settingsButton")
            .accessibilityLabel("Settings")
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 12)
        }
        .background(Color.amux.mist)
    }

    private func section(title: String, scope: ShortcutScope) -> some View {
        let roots = store.children(parentID: nil, scope: scope)
        return Group {
            if !roots.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(title.uppercased()) · \(roots.count)")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.horizontal, 4)

                    VStack(spacing: 6) {
                        ForEach(roots) { node in
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

private struct SettingsRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1.0)
            .scaleEffect(configuration.isPressed ? 0.985 : 1.0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
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
