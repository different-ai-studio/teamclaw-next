import { uuidV4 } from "../../lib/uuid";

type StorageClient = {
  storage: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: (bucket: string) => any;
  };
};

export type UploadedAttachment = {
  path: string;
  publicUrl: string;
  mime: string;
  size: number | null;
};

function inferMime(uri: string, fallback: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heic";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".caf")) return "audio/x-caf";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return fallback;
}

function inferExtension(uri: string, mime: string): string {
  const fromUri = uri.split(".").pop()?.toLowerCase();
  if (fromUri && fromUri.length >= 2 && fromUri.length <= 5 && /^[a-z0-9]+$/.test(fromUri)) {
    return fromUri;
  }
  if (mime.startsWith("image/")) return mime.split("/")[1] ?? "bin";
  if (mime.startsWith("video/")) return mime.split("/")[1] ?? "mp4";
  if (mime.startsWith("audio/")) return "m4a";
  if (mime === "application/pdf") return "pdf";
  return "bin";
}

/**
 * Reads the file behind `localUri` via fetch + blob and uploads it to
 * the `attachments` bucket under `<teamId>/<sessionId>/<uuid>.<ext>`.
 * The path convention matches the iOS app's
 * `AttachmentUploadManager.makeRemotePath` so the same row in
 * `message_attachments` can be read interchangeably.
 *
 * Returns the storage path, a public URL (the bucket is public), the
 * resolved MIME, and the size when available.
 */
export async function uploadAttachment(
  client: StorageClient,
  args: {
    teamId: string;
    sessionId: string;
    localUri: string;
    fallbackMime?: string;
  },
): Promise<UploadedAttachment> {
  const response = await fetch(args.localUri);
  if (!response.ok) {
    throw new Error(`Couldn't read picked file (${response.status}).`);
  }
  const blob = await response.blob();
  const mime = blob.type || inferMime(args.localUri, args.fallbackMime ?? "application/octet-stream");
  const ext = inferExtension(args.localUri, mime);
  const path = `${args.teamId}/${args.sessionId}/${uuidV4()}.${ext}`;

  const bucket = client.storage.from("attachments");
  const result = await bucket.upload(path, blob, {
    cacheControl: "3600",
    contentType: mime,
    upsert: false,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }

  const publicUrl = bucket.getPublicUrl(path).data?.publicUrl ?? "";
  return {
    path,
    publicUrl,
    mime,
    size: blob.size ?? null,
  };
}
