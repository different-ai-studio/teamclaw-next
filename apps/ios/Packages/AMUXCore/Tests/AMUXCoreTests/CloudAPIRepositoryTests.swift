import Foundation
import Testing
@testable import AMUXCore

@Suite("Cloud API repositories")
struct CloudAPIRepositoryTests {
    @Test
    func sessionsAndMessagesUseCloudAPIContract() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                let path = request.url?.path ?? ""
                let query = request.url?.query ?? ""
                if path == "/v1/sessions", query == "limit=100" {
                    return try response("""
                    {
                      "items": [
                        {
                          "id": "session-1",
                          "teamId": "team-1",
                          "title": "Session",
                          "mode": "collab",
                          "ideaId": null,
                          "lastMessageAt": "2026-05-27T10:00:00Z",
                          "lastMessagePreview": "hello",
                          "hasUnread": true,
                          "createdAt": "2026-05-27T09:00:00Z",
                          "updatedAt": null
                        }
                      ],
                      "nextCursor": null
                    }
                    """)
                }
                if path == "/v1/sessions/session-1/messages" {
                    return try response("""
                    {
                      "items": [
                        {
                          "id": "message-1",
                          "teamId": "team-1",
                          "sessionId": "session-1",
                          "turnId": "turn-1",
                          "senderActorId": "actor-1",
                          "replyToMessageId": null,
                          "kind": "text",
                          "content": "hello",
                          "metadata": null,
                          "model": null,
                          "createdAt": "2026-05-27T10:00:00Z",
                          "updatedAt": null
                        }
                      ],
                      "nextCursor": null
                    }
                    """)
                }
                return try response("{}", status: 404)
            }
        )

        let sessionsRepo = CloudAPISessionsRepository(client: client)
        let messagesRepo = CloudAPIMessagesRepository(client: client)

        let sessions = try await sessionsRepo.listSessions(teamID: "team-1")
        let messages = try await messagesRepo.listForSession(sessionID: "session-1")

        #expect(sessions.map(\.id) == ["session-1"])
        #expect(sessions.first?.lastMessagePreview == "hello")
        #expect(messages.map(\.id) == ["message-1"])
        #expect(messages.first?.turnID == "turn-1")
        let requests = await recorder.requests
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer access-token" })
        #expect(requests.map { $0.value(forHTTPHeaderField: "X-Request-Id")?.isEmpty == false }.allSatisfy { $0 })
    }

    @Test
    func messageInsertSendsIdempotencyKey() async throws {
        let recorder = RequestRecorder()
        let client = CloudAPIClient(
            configuration: configuration(),
            accessToken: { "access-token" },
            send: { request in
                await recorder.append(request)
                return try response("""
                {
                  "id": "message-1",
                  "teamId": "team-1",
                  "sessionId": "session-1",
                  "turnId": null,
                  "senderActorId": "actor-1",
                  "replyToMessageId": null,
                  "kind": "text",
                  "content": "hello",
                  "metadata": null,
                  "model": null,
                  "createdAt": "2026-05-27T10:00:00Z",
                  "updatedAt": null
                }
                """)
            }
        )
        let repo = CloudAPIMessagesRepository(client: client)

        try await repo.insert(MessageInsertInput(
            id: "message-1",
            teamID: "team-1",
            sessionID: "session-1",
            senderActorID: "actor-1",
            content: "hello",
            mentionActorIDs: ["agent-1"]
        ))

        let request = try #require(await recorder.requests.first)
        #expect(request.url?.path == "/v1/sessions/session-1/messages")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "message-1")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["id"] as? String == "message-1")
        #expect(json["teamId"] as? String == "team-1")
        #expect((json["metadata"] as? [String: [String]])?["mention_actor_ids"] == ["agent-1"])
    }

    private func configuration() -> CloudAPIConfiguration {
        CloudAPIConfiguration(
            baseURL: URL(string: "https://fc.example.com")!,
            supabaseURL: URL(string: "https://project.supabase.co")!,
            supabaseAnonKey: "anon"
        )
    }

    private func response(_ json: String, status: Int = 200) throws -> (Data, HTTPURLResponse) {
        let url = URL(string: "https://fc.example.com")!
        let http = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (Data(json.utf8), http)
    }
}

private actor RequestRecorder {
    private var stored: [URLRequest] = []

    var requests: [URLRequest] {
        stored
    }

    func append(_ request: URLRequest) {
        stored.append(request)
    }
}
