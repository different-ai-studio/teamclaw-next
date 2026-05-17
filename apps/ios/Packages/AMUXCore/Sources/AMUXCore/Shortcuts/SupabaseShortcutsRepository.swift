import Foundation
import Supabase

public actor SupabaseShortcutsRepository: ShortcutsRepository {
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

    public func listPersonal() async throws -> [ShortcutRecord] {
        let rows: [ShortcutRow] = try await client
            .from("shortcuts")
            .select(Self.selectColumns)
            .eq("scope", value: "personal")
            .order("order", ascending: true)
            .execute()
            .value
        return rows.map(\.record)
    }

    public func listTeam(teamID: String) async throws -> [ShortcutRecord] {
        let rows: [ShortcutRow] = try await client
            .from("shortcuts")
            .select(Self.selectColumns)
            .eq("scope", value: "team")
            .eq("team_id", value: teamID)
            .order("order", ascending: true)
            .execute()
            .value
        return rows.map(\.record)
    }

    private static let selectColumns = """
        id, scope, owner_member_id, team_id, parent_id,
        label, icon, "order", node_type, target,
        created_at, updated_at
    """
}

private struct ShortcutRow: Decodable, Sendable {
    let id: String
    let scope: String
    let ownerMemberID: String?
    let teamID: String?
    let parentID: String?
    let label: String
    let icon: String?
    let order: Int
    let nodeType: String
    let target: String
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case scope
        case ownerMemberID = "owner_member_id"
        case teamID = "team_id"
        case parentID = "parent_id"
        case label
        case icon
        case order
        case nodeType = "node_type"
        case target
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var record: ShortcutRecord {
        ShortcutRecord(
            id: id,
            scope: ShortcutScope(rawValue: scope) ?? .personal,
            ownerMemberID: ownerMemberID,
            teamID: teamID,
            parentID: parentID,
            label: label,
            icon: icon,
            order: order,
            type: ShortcutNodeType(rawValue: nodeType) ?? .native,
            target: target,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}
