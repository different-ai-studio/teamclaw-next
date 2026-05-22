import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

// MARK: - AddAgentSheet

/// Picker presented from `SessionDetailView` when the user taps "Add agent"
/// in the session member sheet. Each row is a `ConnectedAgent` candidate
/// (already filtered to exclude agents currently in the session); tapping
/// one resolves the agent's stored defaults (default_workspace_id +
/// default_agent_type, mirrored on `CachedActor`) and immediately calls `onConfirm`
/// with `(actorID, workspaceID, workspacePath, agentType)`.
///
/// Workspace fallback chain matches `NewSessionSheet.resolveAgentDefaults`:
/// stored default → any workspace owned by the agent → any team workspace.
public struct AddAgentSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Query private var cachedActors: [CachedActor]

    let candidates: [ConnectedAgent]
    let teamID: String
    let onConfirm: (_ actorID: String,
                    _ workspaceID: String,
                    _ workspacePath: String,
                    _ agentType: AgentConfigSheet.AgentType) -> Void

    @State private var workspaceStore: WorkspaceStore?
    @State private var errorMessage: String?

    public init(candidates: [ConnectedAgent],
                teamID: String,
                onConfirm: @escaping (_ actorID: String,
                                      _ workspaceID: String,
                                      _ workspacePath: String,
                                      _ agentType: AgentConfigSheet.AgentType) -> Void) {
        self.candidates = candidates
        self.teamID = teamID
        self.onConfirm = onConfirm
    }

    private var workspaces: [WorkspaceRecord] { workspaceStore?.workspaces ?? [] }

    public var body: some View {
        NavigationStack {
            List {
                if candidates.isEmpty {
                    ContentUnavailableView(
                        "No agents available",
                        systemImage: "person.crop.circle.badge.questionmark",
                        description: Text("All connected agents are already in this session, or no agents are reachable.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(candidates) { agent in
                        Button {
                            handleTap(agent)
                        } label: {
                            HStack(spacing: 8) {
                                Circle()
                                    .fill(agent.isOnline ? .green : .gray.opacity(0.4))
                                    .frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(agent.displayName).font(.body)
                                    if let agentType = agent.defaultAgentType, !agentType.isEmpty {
                                        Text(AgentConfigSheet.AgentType.fromStoredValue(agentType).label)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .tint(.primary)
                    }
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .navigationTitle("Add Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .task {
            guard workspaceStore == nil, !teamID.isEmpty else { return }
            if let repository = try? SupabaseWorkspaceRepository() {
                workspaceStore = WorkspaceStore(teamID: teamID, repository: repository)
                await workspaceStore?.reload(agentID: nil)
            }
        }
    }

    private func handleTap(_ agent: ConnectedAgent) {
        let cached = cachedActors.first(where: { $0.actorId == agent.id })
        let defaultWorkspaceID = cached?.defaultWorkspaceId
        let agentTypes = cached?.agentTypes.isEmpty == false ? (cached?.agentTypes ?? []) : agent.agentTypes
        let kindString = cached?.defaultAgentType ?? agent.defaultAgentType ?? agentTypes.first

        let workspaceID: String? = {
            if let id = defaultWorkspaceID,
               workspaces.contains(where: { $0.id == id }) {
                return id
            }
            if let owned = workspaces.first(where: { $0.agentID == agent.id }) {
                return owned.id
            }
            return workspaces.first?.id
        }()

        guard let workspaceID,
              let workspace = workspaces.first(where: { $0.id == workspaceID }) else {
            errorMessage = "No workspaces available — add one to this agent first."
            return
        }
        let allowedTypes = AgentConfigSheet.AgentType.supported(from: agentTypes)
        let defaultType = AgentConfigSheet.AgentType.fromStoredValue(kindString)
        let agentType = allowedTypes.isEmpty || allowedTypes.contains(defaultType) ? defaultType : (allowedTypes.first ?? .claude)
        onConfirm(agent.id, workspace.id, workspace.path, agentType)
        dismiss()
    }
}
