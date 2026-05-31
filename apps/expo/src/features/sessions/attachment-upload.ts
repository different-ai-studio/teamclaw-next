import { Buffer } from "buffer";
import * as FileSystem from "expo-file-system";

import { cloudApiBaseUrl } from "../../lib/cloud-api/client";
import { uuidV4 } from "../../lib/uuid";

export type UploadedAttachment = {
  path: string;
  publicUrl: string;
  mime: string;
  size: number | null;
};

type LocalFileBody = {
  body: ArrayBuffer;
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

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readLocalFileForUpload(uri: string, fallbackMime: string): Promise<LocalFileBody> {
  try {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Couldn't read picked file (${response.status}).`);
    }
    const blob = await response.blob();
    const body = await blob.arrayBuffer();
    return {
      body,
      mime: blob.type || fallbackMime,
      size: blob.size ?? body.byteLength,
    };
  } catch (fetchError) {
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const bytes = Buffer.from(base64, "base64");
      return {
        body: copyToArrayBuffer(bytes),
        mime: fallbackMime,
        size: bytes.byteLength,
      };
    } catch {
      throw fetchError;
    }
  }
}

/**
 * Reads the file behind `localUri` and uploads it to the Cloud API
 * (`POST /v1/attachments?path=<path>&bucket=<bucket>`, raw bytes) under
 * `<teamId>/<sessionId>/<uuid>.<ext>`. The path convention matches the iOS
 * app's `AttachmentUploadManager.makeRemotePath` so the same row in
 * `message_attachments` can be read interchangeably.
 *
 * The attachments/avatars buckets are public, so FC returns the public object
 * URL directly. Returns the storage path, that public URL, the resolved MIME,
 * and the size when available.
 */
export async function uploadAttachment(args: {
  getAccessToken: () => Promise<string | null>;
  teamId: string;
  sessionId: string;
  localUri: string;
  fallbackMime?: string;
  bucket?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedAttachment> {
  const fallbackMime = inferMime(args.localUri, args.fallbackMime ?? "application/octet-stream");
  const { body, mime, size } = await readLocalFileForUpload(args.localUri, fallbackMime);
  const ext = inferExtension(args.localUri, mime);
  const path = `${args.teamId}/${args.sessionId}/${uuidV4()}.${ext}`;

  const token = await args.getAccessToken();
  if (!token) throw new Error("Missing auth session access token.");
  const baseUrl = (args.baseUrl ?? cloudApiBaseUrl()).replace(/\/+$/, "");
  const bucket = args.bucket ?? "attachments";
  const uploadFetch = args.fetchImpl ?? fetch;
  const query = new URLSearchParams({ path, bucket });

  const response = await uploadFetch(`${baseUrl}/v1/attachments?${query.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mime,
    },
    body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Couldn't upload the file.");
  }

  return {
    path,
    publicUrl: payload?.url ?? "",
    mime,
    size,
  };
}
