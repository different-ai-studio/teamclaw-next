import type { AttachmentRef, AttachmentsBackend, AttachmentUploadInput } from "../types";
import type { CloudApiClient } from "./http";

export function createAttachmentsModule(client: CloudApiClient): AttachmentsBackend {
  return {
    async uploadAttachment(input: AttachmentUploadInput): Promise<AttachmentRef> {
      const attachmentId = crypto.randomUUID();
      const storagePath = `${input.teamId}/${input.sessionId}/${attachmentId}/${input.file.name}`;
      const bytes: BodyInit = await input.file.arrayBuffer();
      const out = await client.postRaw<{ path: string; signedUrl: string; attachmentId: string; fileName: string; mimeType: string; size: number }>(
        `/v1/attachments?path=${encodeURIComponent(storagePath)}`,
        bytes,
        { contentType: input.file.type },
      );
      return {
        attachmentId: out.attachmentId ?? attachmentId,
        fileName: out.fileName ?? input.file.name,
        signedUrl: out.signedUrl,
        mimeType: out.mimeType ?? input.file.type,
        size: out.size ?? input.file.size,
      };
    },
  };
}
