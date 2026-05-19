/**
 * attachment-upload.ts — Upload attachments to Supabase Storage before sending.
 *
 * Mirrors iOS AttachmentUploadManager: bucket="attachments",
 * path="{teamId}/{sessionId}/{attachmentId}/{fileName}", signed URL 1 year.
 */

import { supabase } from "@/lib/supabase-client";

export interface UploadedAttachment {
  attachmentId: string;
  fileName: string;
  signedUrl: string;
  mimeType: string;
  size: number;
}

export async function uploadAttachment(
  file: File,
  { teamId, sessionId }: { teamId: string; sessionId: string },
): Promise<UploadedAttachment> {
  const attachmentId = crypto.randomUUID();
  const storagePath = `${teamId}/${sessionId}/${attachmentId}/${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("attachments")
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;

  const { data: signedData, error: signError } = await supabase.storage
    .from("attachments")
    .createSignedUrl(storagePath, 31_536_000); // 1 year, mirrors iOS
  if (signError) throw signError;

  return {
    attachmentId,
    fileName: file.name,
    signedUrl: signedData.signedUrl,
    mimeType: file.type,
    size: file.size,
  };
}
