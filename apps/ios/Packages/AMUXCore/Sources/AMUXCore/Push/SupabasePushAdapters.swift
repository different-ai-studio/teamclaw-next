import Foundation
import Supabase

// MARK: - SupabaseTokenUploader

public actor SupabaseTokenUploader: PushTokenUploader {
    private let client: SupabaseClient

    public init(client: SupabaseClient) {
        self.client = client
    }

    public func upload(userID: String, deviceID: String, platform: String,
                       provider: String, token: String, appVersion: String?) async throws {
        struct Row: Encodable {
            let user_id: String
            let device_id: String
            let platform: String
            let provider: String
            let token: String
            let app_version: String?
            let last_seen_at: String
        }
        let row = Row(
            user_id: userID,
            device_id: deviceID,
            platform: platform,
            provider: provider,
            token: token,
            app_version: appVersion,
            last_seen_at: ISO8601DateFormatter().string(from: Date())
        )
        try await client
            .from("device_push_tokens")
            .upsert(row, onConflict: "user_id,device_id,provider")
            .execute()
    }
}

// MARK: - SupabasePushPreferences

public actor SupabasePushPreferences: PushPreferencesAPI {
    private let client: SupabaseClient
    private let userID: @Sendable () -> String?

    public init(client: SupabaseClient, userID: @escaping @Sendable () -> String?) {
        self.client = client
        self.userID = userID
    }

    public func load() async throws -> NotificationPrefs {
        guard let uid = userID() else { return NotificationPrefs() }
        struct Row: Decodable {
            let enabled: Bool
            let dnd_start_min: Int?
            let dnd_end_min: Int?
            let dnd_tz: String?
        }
        let rows: [Row] = try await client
            .from("notification_prefs")
            .select()
            .eq("user_id", value: uid)
            .limit(1)
            .execute()
            .value
        guard let r = rows.first else { return NotificationPrefs() }
        return NotificationPrefs(
            enabled: r.enabled,
            dndStartMin: r.dnd_start_min,
            dndEndMin: r.dnd_end_min,
            dndTz: r.dnd_tz ?? TimeZone.current.identifier
        )
    }

    public func save(_ prefs: NotificationPrefs) async throws {
        guard let uid = userID() else { return }
        struct Row: Encodable {
            let user_id: String
            let enabled: Bool
            let dnd_start_min: Int?
            let dnd_end_min: Int?
            let dnd_tz: String
        }
        let row = Row(
            user_id: uid,
            enabled: prefs.enabled,
            dnd_start_min: prefs.dndStartMin,
            dnd_end_min: prefs.dndEndMin,
            dnd_tz: prefs.dndTz
        )
        try await client
            .from("notification_prefs")
            .upsert(row, onConflict: "user_id")
            .execute()
    }

    public func setSessionMuted(sessionID: String, muted: Bool) async throws {
        guard let uid = userID() else { return }
        if muted {
            struct Row: Encodable {
                let user_id: String
                let session_id: String
            }
            try await client
                .from("session_mutes")
                .upsert(Row(user_id: uid, session_id: sessionID),
                        onConflict: "user_id,session_id")
                .execute()
        } else {
            try await client
                .from("session_mutes")
                .delete()
                .eq("user_id", value: uid)
                .eq("session_id", value: sessionID)
                .execute()
        }
    }

    public func isSessionMuted(sessionID: String) async throws -> Bool {
        guard let uid = userID() else { return false }
        struct Row: Decodable { let session_id: String }
        let rows: [Row] = try await client
            .from("session_mutes")
            .select("session_id")
            .eq("user_id", value: uid)
            .eq("session_id", value: sessionID)
            .limit(1)
            .execute()
            .value
        return !rows.isEmpty
    }
}

// MARK: - SupabasePresenceWriter

public actor SupabasePresenceWriter: PresenceWriter {
    private let client: SupabaseClient
    private let userID: @Sendable () -> String?

    public init(client: SupabaseClient, userID: @escaping @Sendable () -> String?) {
        self.client = client
        self.userID = userID
    }

    public func writeForeground(deviceID: String, until: Date) async throws {
        guard let uid = userID() else { return }
        struct Row: Encodable {
            let user_id: String
            let device_id: String
            let foreground_until: String
        }
        let row = Row(
            user_id: uid,
            device_id: deviceID,
            foreground_until: ISO8601DateFormatter().string(from: until)
        )
        try await client
            .from("client_presence")
            .upsert(row, onConflict: "user_id,device_id")
            .execute()
    }
}
