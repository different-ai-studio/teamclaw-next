import { supabase } from "@/lib/supabase-client";

export interface AttachmentRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

/**
 * Uploads files to the `attachments` Supabase Storage bucket and returns
 * structured metadata for each uploaded file.
 *
 * Storage path: `<teamId>/<sessionId>/<uuid>-<filename>`
 * Failures are logged and skipped — partial success is acceptable.
 */
export async function uploadAttachmentsToStorage(
  files: File[],
  teamId: string,
  sessionId: string,
): Promise<AttachmentRecord[]> {
  const results: AttachmentRecord[] = [];

  for (const file of files) {
    const id = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${teamId}/${sessionId}/${id}-${safeName}`;

    const { error } = await supabase.storage
      .from("attachments")
      .upload(path, file, { contentType: file.type });

    if (error) {
      console.error("[attachment-upload] failed:", file.name, error);
      continue;
    }

    results.push({ id, name: file.name, mime: file.type, size: file.size, path });
  }

  return results;
}
