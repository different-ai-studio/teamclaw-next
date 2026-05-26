import { toBackendError } from "../errors";
import { supabase as defaultSupabase } from "./client";
import type { AttachmentRef, AttachmentsBackend, AttachmentUploadInput } from "../types";

const ATTACHMENTS_BUCKET = "attachments";
const SIGNED_URL_TTL_SECONDS = 31_536_000;

type SupabaseAttachmentsClient = {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        file: File,
        options: { contentType: string; upsert: boolean },
      ): Promise<{ error: unknown | null }>;
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<{ data: { signedUrl: string } | null; error: unknown | null }>;
    };
  };
};

function assertSupabaseClient(client: SupabaseAttachmentsClient): void {
  if (!client.storage || typeof client.storage.from !== "function") {
    throw new Error("attachments backend not implemented");
  }
}

export function createSupabaseAttachmentsBackend(client: unknown = defaultSupabase): AttachmentsBackend {
  const supabase = client as SupabaseAttachmentsClient;

  return {
    async uploadAttachment(input: AttachmentUploadInput): Promise<AttachmentRef> {
      assertSupabaseClient(supabase);
      const attachmentId = crypto.randomUUID();
      const storagePath = `${input.teamId}/${input.sessionId}/${attachmentId}/${input.file.name}`;
      const bucket = supabase.storage.from(ATTACHMENTS_BUCKET);

      const { error: uploadError } = await bucket.upload(storagePath, input.file, {
        contentType: input.file.type,
        upsert: false,
      });
      if (uploadError) throw toBackendError(uploadError, "attachments.uploadAttachment");

      const { data, error: signError } = await bucket.createSignedUrl(
        storagePath,
        SIGNED_URL_TTL_SECONDS,
      );
      if (signError) throw toBackendError(signError, "attachments.createSignedUrl");
      if (!data?.signedUrl) {
        throw toBackendError(
          { message: "Attachment signed URL missing", status: 502 },
          "attachments.createSignedUrl",
        );
      }

      return {
        attachmentId,
        fileName: input.file.name,
        signedUrl: data.signedUrl,
        mimeType: input.file.type,
        size: input.file.size,
      };
    },
  };
}
