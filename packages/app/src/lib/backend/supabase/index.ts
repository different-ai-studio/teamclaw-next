import { supabase } from "./client";
import { createSupabaseAttachmentsBackend } from "./attachments";
import { createSupabaseAuthBackend } from "./auth";
import { createSupabaseDirectoryBackend } from "./directory";
import { createSupabaseMessagesBackend } from "./messages";
import { createSupabaseRuntimeBackend } from "./runtime";
import { createSupabaseSessionsBackend } from "./sessions";
import type { TeamClawBackend } from "../types";

export function createSupabaseBackend(): TeamClawBackend {
  return {
    kind: "supabase",
    auth: createSupabaseAuthBackend(supabase),
    directory: createSupabaseDirectoryBackend(supabase),
    sessions: createSupabaseSessionsBackend(supabase),
    messages: createSupabaseMessagesBackend(supabase),
    runtime: createSupabaseRuntimeBackend(supabase),
    attachments: createSupabaseAttachmentsBackend(supabase),
  };
}
