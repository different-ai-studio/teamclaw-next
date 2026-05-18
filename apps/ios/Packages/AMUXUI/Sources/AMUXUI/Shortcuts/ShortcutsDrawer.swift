import SwiftUI
import AMUXCore
import AMUXSharedUI

public struct ShortcutsDrawer: View {
    @Binding var isPresented: Bool
    @Bindable var store: ShortcutsStore

    @State private var expandedIDs: Set<String> = []
    @State private var presentedLink: ShortcutLinkPresentation?

    public init(isPresented: Binding<Bool>, store: ShortcutsStore) {
        self._isPresented = isPresented
        self.store = store
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
            header
            content
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.amux.mist)
        .clipShape(.rect(topLeadingRadius: 0, bottomLeadingRadius: 0, bottomTrailingRadius: 22, topTrailingRadius: 0))
        .shadow(color: Color.amux.onyx.opacity(0.14), radius: 22, x: 6, y: 0)
        .ignoresSafeArea(edges: [.top, .leading, .bottom])
    }

    private var header: some View {
        HStack(spacing: 0) {
            Text("Shortcuts")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Color.amux.onyx)
            Spacer(minLength: 8)
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.amux.basalt)
                    .frame(width: 30, height: 30)
                    .background(Color.amux.pebble, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close shortcuts")
            .accessibilityIdentifier("shortcuts.closeButton")
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.amux.hairline)
                .frame(height: 0.5)
        }
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
            .padding(.vertical, 16)
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
