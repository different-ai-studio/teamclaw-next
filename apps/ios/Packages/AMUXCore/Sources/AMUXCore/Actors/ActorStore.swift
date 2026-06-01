import Foundation
import Observation
import SwiftData

public extension Notification.Name {
    static let amuxInviteTokenReceived = Notification.Name("amuxInviteTokenReceived")
    static let amuxAuthCallbackReceived = Notification.Name("amuxAuthCallbackReceived")
}

@Observable
@MainActor
public final class ActorStore {
    public private(set) var actors: [ActorRecord] = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let teamID: String
    private let repository: any ActorRepository
    private let modelContext: ModelContext
    private var lastHeartbeat: Date = .distantPast

    public init(teamID: String, repository: any ActorRepository, modelContext: ModelContext) {
        self.teamID = teamID
        self.repository = repository
        self.modelContext = modelContext
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        // Scope the shared SwiftData cache to the active team up front, before the
        // network fetch, so actors from a previously-viewed team can't leak into
        // the (unscoped) Actors and Members @Query views as phantom members — not
        // even briefly while the fetch is in flight.
        ActorCacheSynchronizer.deleteForeignTeams(currentTeamID: teamID,
                                                  modelContext: modelContext)
        do {
            let remote = try await repository.listActors(teamID: teamID)
            ActorCacheSynchronizer.upsert(remote, modelContext: modelContext)
            ActorCacheSynchronizer.deleteMissing(keeping: Set(remote.map(\.id)),
                                                 teamID: teamID, modelContext: modelContext)
            actors = remote.sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func createInvite(_ input: InviteCreateInput) async -> InviteCreated? {
        do {
            let r = try await repository.createInvite(teamID: teamID, input: input)
            errorMessage = nil
            return r
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    public func claimInvite(token: String) async -> ClaimResult? {
        do {
            let r = try await repository.claimInvite(token: token)
            await reload()
            return r
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    public func heartbeat() async {
        guard Date().timeIntervalSince(lastHeartbeat) > 30 else { return }
        lastHeartbeat = Date()
        do { try await repository.heartbeat() } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Returns true on success. On failure the error message is set on the store.
    @discardableResult
    public func removeActor(actorID: String) async -> Bool {
        do {
            try await repository.removeActor(actorID: actorID)
            await reload()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Updates an agent's stored defaults (workspace, agent_kind, default_agent_type).
    /// Any nil argument leaves the existing value untouched. Refreshes the local cache on success.
    @discardableResult
    public func updateAgentDefaults(
        actorID: String,
        defaultWorkspaceID: String?,
        agentKind: String?,
        defaultAgentType: String?
    ) async -> AgentDefaults? {
        do {
            let updated = try await repository.updateAgentDefaults(
                actorID: actorID,
                defaultWorkspaceID: defaultWorkspaceID,
                agentKind: agentKind,
                defaultAgentType: defaultAgentType
            )
            await reload()
            return updated
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
