import Foundation

public actor CloudAPITeamRepository: TeamRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func loadDetails(teamID: String) async throws -> TeamDetails {
        let row: CloudTeam = try await client.get("/v1/teams/\(teamID)")
        return TeamDetails(
            id: row.id,
            name: row.name,
            slug: row.slug ?? "",
            createdAt: parseCloudDate(row.createdAt) ?? .distantPast,
            ownerDisplayName: nil
        )
    }
}

public actor CloudAPISessionsRepository: SessionsRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listSessions(teamID: String) async throws -> [SessionRecord] {
        let page: CloudPage<CloudSession> = try await client.get("/v1/sessions?limit=100")
        return page.items
            .filter { $0.teamId == teamID }
            .map { row in
                SessionRecord(
                    id: row.id,
                    teamID: row.teamId,
                    ideaID: row.ideaId,
                    createdByActorID: "",
                    primaryAgentID: nil,
                    mode: row.mode,
                    title: row.title,
                    summary: "",
                    participantCount: 0,
                    lastMessagePreview: row.lastMessagePreview ?? "",
                    lastMessageAt: parseCloudDate(row.lastMessageAt),
                    createdAt: parseCloudDate(row.createdAt) ?? .distantPast
                )
            }
    }

    public func fetchUnreadFlags(limit: Int) async throws -> [String: Bool] {
        let page: CloudPage<CloudSession> = try await client.get("/v1/sessions?limit=\(limit)")
        return page.items.reduce(into: [String: Bool]()) { acc, row in
            acc[row.id] = row.hasUnread
        }
    }

    public func markSessionViewed(sessionId: String, lastReadMessageId: String?) async throws {
        throw CloudAPIError.requestFailed(
            status: 501,
            code: "not_implemented",
            message: "Cloud API does not implement session view markers yet."
        )
    }
}

public actor CloudAPIMessagesRepository: MessagesRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listForSession(sessionID: String) async throws -> [MessageRecord] {
        let page: CloudPage<CloudMessage> = try await client.get("/v1/sessions/\(sessionID)/messages")
        return page.items.map { row in
            MessageRecord(
                id: row.id,
                sessionID: row.sessionId,
                senderActorID: row.senderActorId ?? "",
                kind: row.kind,
                content: row.content,
                createdAt: parseCloudDate(row.createdAt) ?? .distantPast,
                model: row.model,
                turnID: row.turnId,
                sequence: 0
            )
        }
    }

    public func insert(_ input: MessageInsertInput) async throws {
        let metadata: [String: [String]]? = input.mentionActorIDs.isEmpty
            ? nil
            : ["mention_actor_ids": input.mentionActorIDs]
        let body = CloudInsertMessageRequest(
            id: input.id,
            teamId: input.teamID,
            senderActorId: input.senderActorID,
            content: input.content,
            kind: input.kind,
            metadata: metadata,
            turnId: nil,
            replyToMessageId: nil,
            model: nil,
            createdAt: nil
        )
        let _: CloudMessage = try await client.post(
            "/v1/sessions/\(input.sessionID)/messages",
            body: body,
            idempotencyKey: input.id
        )
    }
}

public actor CloudAPIInviteClaimer {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func claimInvite(token: String) async throws -> ClaimResult {
        let row: CloudClaimInviteResult = try await client.post(
            "/v1/invites/claim",
            body: CloudClaimInviteRequest(token: token)
        )
        return ClaimResult(
            actorID: row.actorId,
            teamID: row.teamId,
            actorType: row.actorType,
            displayName: row.displayName,
            refreshToken: row.refreshToken
        )
    }
}

public enum CloudAPIRepositoryFactory {
    public static func client(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> CloudAPIClient {
        CloudAPIClient(configuration: configuration, accessToken: accessToken)
    }

    public static func sessionsRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any SessionsRepository {
        CloudAPISessionsRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func messagesRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any MessagesRepository {
        CloudAPIMessagesRepository(client: client(configuration: configuration, accessToken: accessToken))
    }

    public static func teamRepository(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String
    ) -> any TeamRepository {
        CloudAPITeamRepository(client: client(configuration: configuration, accessToken: accessToken))
    }
}

private struct CloudPage<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
    let nextCursor: String?
}

private struct CloudTeam: Decodable, Sendable {
    let id: String
    let name: String
    let slug: String?
    let createdAt: String?
}

private struct CloudSession: Decodable, Sendable {
    let id: String
    let teamId: String
    let title: String
    let mode: String
    let ideaId: String?
    let lastMessageAt: String?
    let lastMessagePreview: String?
    let hasUnread: Bool
    let createdAt: String?
}

private struct CloudMessage: Decodable, Sendable {
    let id: String
    let teamId: String
    let sessionId: String
    let turnId: String?
    let senderActorId: String?
    let replyToMessageId: String?
    let kind: String
    let content: String
    let model: String?
    let createdAt: String
}

private struct CloudInsertMessageRequest<Metadata: Encodable & Sendable>: Encodable, Sendable {
    let id: String
    let teamId: String
    let senderActorId: String
    let content: String
    let kind: String
    let metadata: Metadata?
    let turnId: String?
    let replyToMessageId: String?
    let model: String?
    let createdAt: String?
}

private struct CloudClaimInviteRequest: Encodable, Sendable {
    let token: String
}

private struct CloudClaimInviteResult: Decodable, Sendable {
    let actorId: String
    let teamId: String
    let actorType: String
    let displayName: String
    let refreshToken: String?
}

private func parseCloudDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    if let date = ISO8601DateFormatter.cloudWithFractionalSeconds.date(from: value) {
        return date
    }
    return ISO8601DateFormatter.cloud.date(from: value)
}

private extension ISO8601DateFormatter {
    static let cloudWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let cloud: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
