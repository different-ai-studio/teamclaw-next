import Foundation

public struct IdeaActivityRecord: Codable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public let ideaID: String
    public let actorID: String
    public let activityType: String
    public let content: String
    public let metadata: [String: String]
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: String,
        teamID: String,
        ideaID: String,
        actorID: String,
        activityType: String,
        content: String,
        metadata: [String: String] = [:],
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.teamID = teamID
        self.ideaID = ideaID
        self.actorID = actorID
        self.activityType = activityType
        self.content = content
        self.metadata = metadata
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var isProgress: Bool { activityType == "progress" }
    public var isStatusChange: Bool { activityType == "status_change" }
    public var isReorder: Bool { activityType == "reorder" }

    public static let attachmentURLsMetadataKey = "attachment_urls"

    public var attachmentURLs: [URL] {
        guard let raw = metadata[Self.attachmentURLsMetadataKey] else { return [] }
        return raw
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .compactMap { value in
                guard let url = URL(string: value),
                      let scheme = url.scheme?.lowercased(),
                      ["http", "https"].contains(scheme),
                      url.host != nil else {
                    return nil
                }
                return url
            }
    }
}
