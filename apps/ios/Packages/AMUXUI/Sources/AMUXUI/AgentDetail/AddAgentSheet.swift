import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

// MARK: - AddAgentSheet

/// Picker presented from `SessionDetailView` when the user taps "Add agent"
/// in the session member sheet. Each row is a `ConnectedAgent` candidate
/// (already filtered to exclude agents currently in the session); tapping
/// one resolves the agent's stored defaults (default_workspace_id +
/// agent_kind, mirrored on `CachedActor`) and immediately calls `onConfirm`
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
            ZStack {
                Color.amux.mist.ignoresSafeArea()
                if candidates.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            HaiSectionLabel("Available Agents")
                            HaiPaperCard {
                                ForEach(Array(candidates.enumerated()), id: \.element.id) { index, agent in
                                    if index > 0 {
                                        Rectangle()
                                            .fill(Color.amux.hairline)
                                            .frame(height: 0.5)
                                            .padding(.leading, 32)
                                    }
                                    Button { handleTap(agent) } label: {
                                        agentRow(agent)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            if let errorMessage {
                                Text(errorMessage)
                                    .font(.system(size: 13))
                                    .foregroundStyle(Color.amux.cinnabarDeep)
                                    .padding(.horizontal, 24)
                            }
                        }
                        .padding(.top, 16)
                        .padding(.bottom, 24)
                    }
                }
            }
            .navigationTitle("Add Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(Color.amux.slate)
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

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("No agents available")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.amux.basalt)
            Text("All connected agents are already in this session,\nor no agents are reachable.")
                .font(.system(size: 13))
                .foregroundStyle(Color.amux.slate)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 32)
    }

    @ViewBuilder
    private func agentRow(_ agent: ConnectedAgent) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(agent.isOnline ? Color.amux.sage : Color.amux.slate.opacity(0.5))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.displayName)
                    .font(.system(size: 14.5))
                    .foregroundStyle(Color.amux.onyx)
                if !agent.agentKind.isEmpty {
                    Text(agent.agentKind.uppercased())
                        .font(.system(size: 10, design: .monospaced))
                        .tracking(0.28)
                        .foregroundStyle(Color.amux.slate)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.amux.slate)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .contentShape(Rectangle())
    }

    private func handleTap(_ agent: ConnectedAgent) {
        let cached = cachedActors.first(where: { $0.actorId == agent.id })
        let defaultWorkspaceID = cached?.defaultWorkspaceId
        let kindString = cached?.agentKind ?? agent.agentKind

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
        let agentType = AgentConfigSheet.AgentType(rawValue: kindString) ?? .claude
        onConfirm(agent.id, workspace.id, workspace.path, agentType)
        dismiss()
    }
}
