import XCTest
@testable import AMUXCore

final class SupabaseSessionBridgeTests: XCTestCase {
    func testSeedsSessionStoreWhenEmptyAndRunsOnce() async throws {
        let storage = InMemorySessionStorage()
        let refreshCount = LockedBox<Int>(); refreshCount.set(0)
        let send: CloudAPISend = { req in
            refreshCount.set((refreshCount.get() ?? 0) + 1)
            let json = #"{"accessToken":"AT","refreshToken":"RT2","expiresAt":9000000000}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (json.data(using: .utf8)!, resp)
        }
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage, send: send)
        await store.start()

        let providerCalls = LockedBox<Int>(); providerCalls.set(0)
        let bridge = SupabaseSessionBridge(sessionStore: store,
            baseURL: URL(string: "https://c")!, send: send,
            legacyRefreshTokenProvider: { providerCalls.set((providerCalls.get() ?? 0) + 1); return "LEGACY_RT" })

        try await bridge.migrateIfNeeded()
        XCTAssertEqual(try storage.load()?.refreshToken, "RT2")
        XCTAssertEqual(refreshCount.get(), 1)

        // Second call: session already present => no provider call, no refresh.
        try await bridge.migrateIfNeeded()
        XCTAssertEqual(providerCalls.get(), 1)
        XCTAssertEqual(refreshCount.get(), 1)
    }

    func testNoLegacyTokenIsNoop() async throws {
        let storage = InMemorySessionStorage()
        let store = SessionStore(baseURL: URL(string: "https://c")!, storage: storage,
            send: { _ in (Data(), HTTPURLResponse(url: URL(string: "https://c")!, statusCode: 500, httpVersion: nil, headerFields: nil)!) })
        await store.start()
        let bridge = SupabaseSessionBridge(sessionStore: store,
            baseURL: URL(string: "https://c")!, send: CloudAPIClient.urlSessionSend,
            legacyRefreshTokenProvider: { nil })
        try await bridge.migrateIfNeeded()
        XCTAssertNil(try storage.load())
    }
}
