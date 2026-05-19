import SwiftUI
import AMUXCore
import AMUXSharedUI

public struct MembersTab: View {
    let pairing: PairingManager
    let mqtt: MQTTService
    let sessionViewModel: SessionListViewModel
    let teamclawService: TeamclawService?
    let activeTeam: TeamSummary?
    let currentActorID: String?
    let store: ActorStore
    let connectedAgentsStore: ConnectedAgentsStore?
    let onSignOut: (() -> Void)?
    /// One-shot trigger from the parent (e.g. the zero-agent reminder) to
    /// open the invite sheet without a toolbar tap. Toggled back to false
    /// after firing so subsequent triggers re-fire cleanly.
    @Binding var externalInviteTrigger: Bool

    @State private var showInvite   = false
    @State private var showSettings = false

    public init(pairing: PairingManager,
                mqtt: MQTTService,
                sessionViewModel: SessionListViewModel,
                teamclawService: TeamclawService?,
                activeTeam: TeamSummary?,
                currentActorID: String? = nil,
                store: ActorStore,
                connectedAgentsStore: ConnectedAgentsStore? = nil,
                onSignOut: (() -> Void)? = nil,
                showInvite: Binding<Bool> = .constant(false)) {
        self.pairing = pairing
        self.mqtt = mqtt
        self.sessionViewModel = sessionViewModel
        self.teamclawService = teamclawService
        self.activeTeam = activeTeam
        self.currentActorID = currentActorID
        self.store = store
        self.connectedAgentsStore = connectedAgentsStore
        self.onSignOut = onSignOut
        self._externalInviteTrigger = showInvite
    }

    public var body: some View {
        NavigationStack {
            MemberListContent(
                store: store,
                pairing: pairing,
                mqtt: mqtt,
                sessionViewModel: sessionViewModel,
                teamclawService: teamclawService,
                currentActorID: currentActorID,
                connectedAgentsStore: connectedAgentsStore,
                onAddYourAgent: { showInvite = true }
            )
                .navigationTitle("Actors")
                .navigationBarTitleDisplayMode(.large)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button { showSettings = true } label: {
                            Image(systemName: "gearshape")
                                .font(.title3)
                                .foregroundStyle(Color.amux.onyx)
                                .accessibilityHidden(true)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Settings")
                        .accessibilityIdentifier("members.settingsButton")
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showInvite = true } label: {
                            Image(systemName: "person.badge.plus")
                                .font(.title3)
                                .foregroundStyle(activeTeam == nil ? Color.amux.slate.opacity(0.5) : Color.amux.onyx)
                                .accessibilityHidden(true)
                        }
                        .buttonStyle(.plain)
                        .disabled(activeTeam == nil)
                        .accessibilityLabel("Invite Member")
                        .accessibilityIdentifier("members.inviteButton")
                    }
                }
                .sheet(isPresented: $showInvite) {
                    MemberInviteSheet(store: store)
                }
                .sheet(isPresented: $showSettings) {
                    SettingsView(connectedAgentsStore: connectedAgentsStore,
                                 activeTeam: activeTeam,
                                 onSignOut: onSignOut)
                }
                .onChange(of: externalInviteTrigger) { _, newValue in
                    guard newValue else { return }
                    showInvite = true
                    externalInviteTrigger = false
                }
        }
    }
}
