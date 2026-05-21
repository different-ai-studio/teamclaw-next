import Foundation
import Supabase

public struct SessionRecord: Equatable, Sendable {
    public let id: String
    public let teamID: String
    public let ideaID: String?
    public let createdByActorID: String
    public let primaryAgentID: String?
    public let mode: String
    public let title: String
    public let summary: String
    public let participantCount: Int
    public let lastMessagePreview: String
    public let lastMessageAt: Date?
    public let createdAt: Date
}

public protocol SessionsRepository: Sendable {
    func listSessions(teamID: String) async throws -> [SessionRecord]
    /// Returns the `(session_id, has_unread)` map computed server-side by
    /// `list_current_actor_sessions` (sessions.last_message_at > session_read_markers.last_read_at).
    /// Used by the inbox red-dot feature to authoritatively know which
    /// sessions have unseen peer messages without each client tracking the
    /// state locally.
    func fetchUnreadFlags(limit: Int) async throws -> [String: Bool]
    /// Marks the current actor as having viewed `sessionId` up to
    /// `lastReadMessageId`. Server upserts `session_read_markers` so other
    /// devices' next `fetchUnreadFlags` reflects the read.
    func markSessionViewed(sessionId: String, lastReadMessageId: String?) async throws
}

public actor SupabaseSessionsRepository: SessionsRepository {
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

    public func fetchUnreadFlags(limit: Int = 100) async throws -> [String: Bool] {
        let rows: [CurrentActorSessionRow] = try await client
            .rpc(
                "list_current_actor_sessions",
                params: ListCurrentActorSessionsParams(p_limit: limit)
            )
            .execute()
            .value
        return rows.reduce(into: [String: Bool]()) { acc, row in
            acc[row.id] = row.hasUnread
        }
    }

    public func markSessionViewed(sessionId: String, lastReadMessageId: String? = nil) async throws {
        _ = try await client
            .rpc(
                "mark_current_actor_session_viewed",
                params: MarkSessionViewedParams(
                    p_session_id: sessionId,
                    p_last_read_message_id: lastReadMessageId
                )
            )
            .execute()
    }

    public func listSessions(teamID: String) async throws -> [SessionRecord] {
        let sessionRows: [SessionRow] = try await client
            .from("sessions")
            .select(
                """
                id,
                team_id,
                idea_id,
                created_by_actor_id,
                primary_agent_id,
                mode,
                title,
                summary,
                last_message_preview,
                last_message_at,
                created_at
                """
            )
            .eq("team_id", value: teamID)
            .order("last_message_at", ascending: false)
            .execute()
            .value

        let sessionIDs = sessionRows.map(\.id)
        guard !sessionIDs.isEmpty else { return [] }

        let participantRows: [SessionParticipantCountRow] = try await client
            .from("session_participants")
            .select("session_id")
            .in("session_id", values: sessionIDs)
            .execute()
            .value

        let counts = participantRows.reduce(into: [String: Int]()) { partial, row in
            partial[row.sessionID, default: 0] += 1
        }

        return sessionRows.map { row in
            SessionRecord(
                id: row.id,
                teamID: row.teamID,
                ideaID: row.ideaID,
                createdByActorID: row.createdByActorID,
                primaryAgentID: row.primaryAgentID,
                mode: row.mode,
                title: row.title,
                summary: row.summary,
                participantCount: counts[row.id, default: 0],
                lastMessagePreview: row.lastMessagePreview ?? "",
                lastMessageAt: row.lastMessageAt,
                createdAt: row.createdAt
            )
        }
    }
}

private struct SessionRow: Decodable, Sendable {
    let id: String
    let teamID: String
    let ideaID: String?
    let createdByActorID: String
    let primaryAgentID: String?
    let mode: String
    let title: String
    let summary: String
    let lastMessagePreview: String?
    let lastMessageAt: Date?
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case teamID = "team_id"
        case ideaID = "idea_id"
        case createdByActorID = "created_by_actor_id"
        case primaryAgentID = "primary_agent_id"
        case mode
        case title
        case summary
        case lastMessagePreview = "last_message_preview"
        case lastMessageAt = "last_message_at"
        case createdAt = "created_at"
    }
}

private struct SessionParticipantCountRow: Decodable, Sendable {
    let sessionID: String

    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
    }
}

private struct CurrentActorSessionRow: Decodable, Sendable {
    let id: String
    let hasUnread: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case hasUnread = "has_unread"
    }
}

private struct ListCurrentActorSessionsParams: Encodable, Sendable {
    let p_limit: Int
}

private struct MarkSessionViewedParams: Encodable, Sendable {
    let p_session_id: String
    let p_last_read_message_id: String?
}
