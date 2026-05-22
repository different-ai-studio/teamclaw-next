import Foundation
import Supabase

public enum IdeaRepositoryError: LocalizedError {
    case missingTitle
    case emptyResponse(String)

    public var errorDescription: String? {
        switch self {
        case .missingTitle:
            return "Title is required."
        case .emptyResponse(let functionName):
            return "\(functionName) returned no rows."
        }
    }
}

public actor SupabaseIdeaRepository: IdeaRepository {
    private let client: SupabaseClient

    public init(configuration: SupabaseProjectConfiguration) {
        self.client = SupabaseClient(
            supabaseURL: configuration.url,
            supabaseKey: configuration.publishableKey
        )
    }

    public init() throws {
        let configuration = try SupabaseProjectConfiguration.fromMainBundle()
        self.client = SupabaseClient(
            supabaseURL: configuration.url,
            supabaseKey: configuration.publishableKey
        )
    }

    public func listIdeas(teamID: String) async throws -> [IdeaRecord] {
        let rows: [IdeaRow] = try await client
            .from("ideas")
            .select(
                """
                id,
                team_id,
                workspace_id,
                created_by_actor_id,
                title,
                description,
                status,
                archived,
                sort_order,
                created_at,
                updated_at
                """
            )
            .eq("team_id", value: teamID)
            .order("sort_order", ascending: true)
            .order("updated_at", ascending: false)
            .execute()
            .value

        return rows.map(\.record)
    }

    public func createIdea(teamID: String, input: IdeaCreateInput) async throws -> IdeaRecord {
        let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let workspaceID = normalizedWorkspaceID(input.workspaceID)

        guard !title.isEmpty else {
            throw IdeaRepositoryError.missingTitle
        }

        let rows: [IdeaRow] = try await client
            .rpc(
                "create_idea",
                params: CreateIdeaParams(
                    teamID: teamID,
                    workspaceID: workspaceID,
                    title: title,
                    description: input.description
                )
            )
            .execute()
            .value

        guard let row = rows.first else {
            throw IdeaRepositoryError.emptyResponse("create_idea")
        }

        return row.record
    }

    public func reorderIdeas(teamID: String, ideaIDs: [String]) async throws {
        try await client
            .rpc(
                "reorder_ideas",
                params: ReorderIdeasParams(teamID: teamID, ideaIDs: ideaIDs)
            )
            .execute()
    }

    public func listIdeaActivities(ideaID: String) async throws -> [IdeaActivityRecord] {
        let rows: [IdeaActivityRow] = try await client
            .from("idea_activities")
            .select(
                """
                id,
                team_id,
                idea_id,
                actor_id,
                activity_type,
                content,
                metadata,
                created_at,
                updated_at
                """
            )
            .eq("idea_id", value: ideaID)
            .order("created_at", ascending: false)
            .execute()
            .value

        return rows.map(\.record)
    }

    public func createIdeaActivity(ideaID: String, input: IdeaActivityCreateInput) async throws -> IdeaActivityRecord {
        let rows: [IdeaActivityRow] = try await client
            .rpc(
                "create_idea_activity",
                params: CreateIdeaActivityParams(
                    ideaID: ideaID,
                    activityType: input.activityType,
                    content: input.content,
                    metadata: input.metadata
                )
            )
            .execute()
            .value

        guard let row = rows.first else {
            throw IdeaRepositoryError.emptyResponse("create_idea_activity")
        }

        return row.record
    }

    public func updateIdea(ideaID: String, input: IdeaUpdateInput) async throws -> IdeaRecord {
        let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let workspaceID = normalizedWorkspaceID(input.workspaceID)

        guard !title.isEmpty else {
            throw IdeaRepositoryError.missingTitle
        }

        let rows: [IdeaRow] = try await client
            .rpc(
                "update_idea",
                params: UpdateIdeaParams(
                    ideaID: ideaID,
                    workspaceID: workspaceID,
                    title: title,
                    description: input.description,
                    status: input.status
                )
            )
            .execute()
            .value

        guard let row = rows.first else {
            throw IdeaRepositoryError.emptyResponse("update_idea")
        }

        return row.record
    }

    public func setArchived(ideaID: String, archived: Bool) async throws -> IdeaRecord {
        let rows: [IdeaRow] = try await client
            .rpc(
                "archive_idea",
                params: ArchiveIdeaParams(ideaID: ideaID, archived: archived)
            )
            .execute()
            .value

        guard let row = rows.first else {
            throw IdeaRepositoryError.emptyResponse("archive_idea")
        }

        return row.record
    }

    private func normalizedWorkspaceID(_ workspaceID: String) -> String? {
        let trimmed = workspaceID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct CreateIdeaParams: Encodable {
    let teamID: String
    let workspaceID: String?
    let title: String
    let description: String

    enum CodingKeys: String, CodingKey {
        case teamID = "p_team_id"
        case workspaceID = "p_workspace_id"
        case title = "p_title"
        case description = "p_description"
    }
}

private struct UpdateIdeaParams: Encodable {
    let ideaID: String
    let workspaceID: String?
    let title: String
    let description: String
    let status: String

    enum CodingKeys: String, CodingKey {
        case ideaID = "p_idea_id"
        case workspaceID = "p_workspace_id"
        case title = "p_title"
        case description = "p_description"
        case status = "p_status"
    }
}

private struct ArchiveIdeaParams: Encodable {
    let ideaID: String
    let archived: Bool

    enum CodingKeys: String, CodingKey {
        case ideaID = "p_idea_id"
        case archived = "p_archived"
    }
}

private struct ReorderIdeasParams: Encodable {
    let teamID: String
    let ideaIDs: [String]

    enum CodingKeys: String, CodingKey {
        case teamID = "p_team_id"
        case ideaIDs = "p_idea_ids"
    }
}

private struct CreateIdeaActivityParams: Encodable {
    let ideaID: String
    let activityType: String
    let content: String
    let metadata: [String: String]

    enum CodingKeys: String, CodingKey {
        case ideaID = "p_idea_id"
        case activityType = "p_activity_type"
        case content = "p_content"
        case metadata = "p_metadata"
    }
}

private struct IdeaRow: Decodable, Sendable {
    let id: String
    let teamID: String
    let workspaceID: String?
    let createdByActorID: String
    let title: String
    let description: String
    let status: String
    let archived: Bool
    let sortOrder: Int
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case teamID = "team_id"
        case workspaceID = "workspace_id"
        case createdByActorID = "created_by_actor_id"
        case title
        case description
        case status
        case archived
        case sortOrder = "sort_order"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var record: IdeaRecord {
        IdeaRecord(
            id: id,
            teamID: teamID,
            workspaceID: workspaceID ?? "",
            createdByActorID: createdByActorID,
            title: title,
            description: description,
            status: status,
            archived: archived,
            sortOrder: sortOrder,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

private struct IdeaActivityRow: Decodable, Sendable {
    let id: String
    let teamID: String
    let ideaID: String
    let actorID: String
    let activityType: String
    let content: String
    let metadata: [String: String]
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case teamID = "team_id"
        case ideaID = "idea_id"
        case actorID = "actor_id"
        case activityType = "activity_type"
        case content
        case metadata
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var record: IdeaActivityRecord {
        IdeaActivityRecord(
            id: id,
            teamID: teamID,
            ideaID: ideaID,
            actorID: actorID,
            activityType: activityType,
            content: content,
            metadata: metadata,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}
