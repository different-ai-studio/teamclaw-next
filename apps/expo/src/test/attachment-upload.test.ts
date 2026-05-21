import { beforeEach, describe, expect, it, vi } from "vitest";

const fileSystemMock = vi.hoisted(() => ({
  readAsStringAsync: vi.fn(),
  EncodingType: { Base64: "base64" },
}));

vi.mock("expo-file-system", () => fileSystemMock);

describe("uploadAttachment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    fileSystemMock.readAsStringAsync.mockReset();
  });

  it("returns a signed read URL for the private attachments bucket", async () => {
    const { uploadAttachment } = await import("../features/sessions/attachment-upload");
    const blob = new Blob(["image-bytes"], { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: vi.fn().mockResolvedValue(blob),
    });
    vi.stubGlobal("fetch", fetchMock);

    const upload = vi.fn().mockResolvedValue({ error: null });
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.example.test/signed.png?token=abc" },
      error: null,
    });
    const getPublicUrl = vi.fn().mockReturnValue({
      data: { publicUrl: "https://storage.example.test/public.png" },
    });
    const from = vi.fn().mockReturnValue({ upload, createSignedUrl, getPublicUrl });

    const result = await uploadAttachment(
      { storage: { from } } as any,
      {
        teamId: "team-1",
        sessionId: "session-1",
        localUri: "file:///tmp/photo.png",
        fallbackMime: "image/png",
      },
    );

    expect(from).toHaveBeenCalledWith("attachments");
    const uploadedBody = upload.mock.calls[0]?.[1] as ArrayBuffer;
    expect(uploadedBody).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(uploadedBody))).toEqual(
      Array.from(new Uint8Array(await blob.arrayBuffer())),
    );
    expect(upload).toHaveBeenCalledWith(
      result.path,
      uploadedBody,
      expect.objectContaining({ contentType: "image/png" }),
    );
    expect(createSignedUrl).toHaveBeenCalledWith(result.path, 31_536_000);
    expect(getPublicUrl).not.toHaveBeenCalled();
    expect(result.publicUrl).toBe("https://storage.example.test/signed.png?token=abc");
  });

  it("falls back to Expo FileSystem when React Native fetch cannot read the local URI", async () => {
    const { uploadAttachment } = await import("../features/sessions/attachment-upload");
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    vi.stubGlobal("fetch", fetchMock);
    fileSystemMock.readAsStringAsync.mockResolvedValue("aW1n");

    let uploadedBody: ArrayBuffer | null = null;
    const upload = vi.fn().mockImplementation((_path: string, body: ArrayBuffer) => {
      uploadedBody = body;
      return Promise.resolve({ error: null });
    });
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.example.test/signed.jpg?token=abc" },
      error: null,
    });
    const from = vi.fn().mockReturnValue({ upload, createSignedUrl });

    const result = await uploadAttachment(
      { storage: { from } } as any,
      {
        teamId: "team-1",
        sessionId: "session-1",
        localUri: "file:///tmp/photo.jpg",
        fallbackMime: "image/jpeg",
      },
    );

    expect(fileSystemMock.readAsStringAsync).toHaveBeenCalledWith(
      "file:///tmp/photo.jpg",
      { encoding: "base64" },
    );
    expect(result.mime).toBe("image/jpeg");
    expect(result.size).toBe(3);
    if (!uploadedBody) {
      throw new Error("Expected upload body to be captured.");
    }
    expect(uploadedBody).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(uploadedBody))).toEqual([105, 109, 103]);
  });
});
