import type { ServerConfig } from "@/lib/server-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPocketBaseBackend } from "../index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PocketBase backend preview auth", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs in with seeded preview credentials and persists the session", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8090/api/collections/accounts/auth-with-password");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        identity: "preview+member@teamclaw.local",
        password: "teamclaw-preview",
      });
      return new Response(
        JSON.stringify({
          token: "header.payload.signature",
          record: {
            id: "account-1",
            email: "preview+member@teamclaw.local",
            display_name: "Preview User",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = createPocketBaseBackend({
      pocketbaseUrl: "http://127.0.0.1:8090/",
    } satisfies ServerConfig);
    const seen: Array<string | null> = [];
    const unsubscribe = backend.auth.onAuthStateChange((session) => seen.push(session?.user.id ?? null));

    const session = await backend.auth.signInAnonymously();

    expect(session?.user).toMatchObject({
      id: "account-1",
      email: "preview+member@teamclaw.local",
    });
    await expect(backend.auth.getSession()).resolves.toMatchObject({
      user: { id: "account-1" },
      accessToken: "header.payload.signature",
    });
    expect(seen).toEqual(["account-1"]);

    await backend.auth.signOut();

    await expect(backend.auth.getSession()).resolves.toBeNull();
    expect(seen).toEqual(["account-1", null]);
    unsubscribe();
  });

  it("lets PocketBase mint session ids and preserves live message ids", async () => {
    const requestBodies: Record<string, Array<Record<string, unknown>>> = {};
    const fetchMock = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const path = String(url).replace("http://127.0.0.1:8090/api/", "");
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requestBodies[path] ??= [];
      requestBodies[path].push(body);

      if (path === "collections/sessions/records") {
        expect(body).not.toHaveProperty("id");
        return jsonResponse({
          id: "pb_session_1",
          team: "team-1",
          title: body.title,
          mode: body.mode,
          created: "2026-05-26T00:00:00.000Z",
          updated: "2026-05-26T00:00:00.000Z",
        });
      }
      if (path === "collections/session_participants/records") {
        return jsonResponse({ id: "participant-1" });
      }
      if (path === "collections/messages/records") {
        expect(body).not.toHaveProperty("id");
        expect(body.client_message_id).toBe("d817451b-d8a0-4217-a214-3c98d57d83c7");
        return jsonResponse({
          id: "pb_message_1",
          client_message_id: body.client_message_id,
          team: body.team,
          session: body.session,
          sender_actor: body.sender_actor,
          kind: body.kind,
          content: body.content,
          metadata: body.metadata,
          created: "2026-05-26T00:00:01.000Z",
          updated: "2026-05-26T00:00:01.000Z",
        });
      }
      if (path === "collections/sessions/records/pb_session_1") {
        return jsonResponse({ id: "pb_session_1" });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const backend = createPocketBaseBackend({
      pocketbaseUrl: "http://127.0.0.1:8090",
    } satisfies ServerConfig);

    const created = await backend.sessions.createSessionShell({
      id: "4c0c31e8-f8f3-4b12-b719-c263ea52fe40",
      teamId: "team-1",
      createdByActorId: "member-1",
      title: "hello",
      additionalActorIds: ["agent-1"],
    });
    const message = await backend.messages.insertOutgoingMessage({
      id: "d817451b-d8a0-4217-a214-3c98d57d83c7",
      teamId: "team-1",
      sessionId: created.sessionId,
      senderActorId: "member-1",
      content: "hello",
    });

    expect(created.sessionId).toBe("pb_session_1");
    expect(message.id).toBe("d817451b-d8a0-4217-a214-3c98d57d83c7");
    expect(requestBodies["collections/messages/records"][0].session).toBe("pb_session_1");
  });
});
