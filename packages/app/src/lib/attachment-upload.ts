/**
 * attachment-upload.ts — Upload attachments before sending.
 */

import { getBackend } from "@/lib/backend";

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
  return getBackend().attachments.uploadAttachment({ file, teamId, sessionId });
}
