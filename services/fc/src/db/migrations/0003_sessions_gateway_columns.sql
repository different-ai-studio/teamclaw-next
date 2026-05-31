-- Add acp_session_id and binding columns to sessions for gateway integration
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "acp_session_id" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "binding" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_team_binding_uniq" UNIQUE ("team_id", "binding");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
