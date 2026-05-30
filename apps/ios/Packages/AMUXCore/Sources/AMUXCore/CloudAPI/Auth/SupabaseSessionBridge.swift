import Foundation

/// One-shot migration of an existing Supabase-SDK session into the CloudAPI
/// SessionStore. Runs only when SessionStore has no session yet. The legacy
/// refresh token is read via an injectable provider (production wiring reads
/// it from the Supabase SDK once; tests inject a stub).
public struct SupabaseSessionBridge: Sendable {
    private let sessionStore: SessionStore
    private let http: AuthHTTP
    private let legacyRefreshTokenProvider: @Sendable () async -> String?

    public init(sessionStore: SessionStore, baseURL: URL,
                send: @escaping CloudAPISend = CloudAPIClient.urlSessionSend,
                legacyRefreshTokenProvider: @escaping @Sendable () async -> String?) {
        self.sessionStore = sessionStore
        self.http = AuthHTTP(baseURL: baseURL, send: send)
        self.legacyRefreshTokenProvider = legacyRefreshTokenProvider
    }

    public func migrateIfNeeded() async throws {
        if await sessionStore.currentSession() != nil { return }
        guard let legacyRT = await legacyRefreshTokenProvider() else { return }
        struct Req: Encodable { let refreshToken: String }
        struct Res: Decodable { let accessToken, refreshToken: String; let expiresAt: Int }
        let res: Res?
        do {
            res = try await http.post("/v1/auth/refresh", body: Req(refreshToken: legacyRT), as: Res.self)
        } catch {
            res = nil
        }
        guard let res else { return }
        await sessionStore.setSession(StoredSession(
            accessToken: res.accessToken, refreshToken: res.refreshToken,
            expiresAt: Date(timeIntervalSince1970: TimeInterval(res.expiresAt)),
            isAnonymous: false, email: nil))
    }
}
