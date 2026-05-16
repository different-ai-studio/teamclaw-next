-- Fix the broken SELECT policy on the attachments bucket.
--
-- The original policy in 20260514002741_create_attachments_bucket.sql
-- references public.session_members.{user_id, session_id} — but that table
-- doesn't exist; the real table is public.session_participants(session_id,
-- actor_id). As written, every SELECT was rejected, so no one could
-- download attachments at all.
--
-- Object path convention used by the gateway port:
--   <team_id>/<session_id>/<uuid>-<filename>
-- SPLIT_PART(name, '/', 2) extracts session_id from that pattern.
--
-- Auth model: only TeamClaw human members (member actors with a Supabase
-- auth user_id) can download. External-IM users (actor_type = 'external')
-- don't have auth.users rows and access the bot via their IM platform,
-- not via Supabase, so they're correctly excluded from direct download.

drop policy if exists "session_members_can_download" on storage.objects;

create policy "session_participants_can_download"
on storage.objects for select
to authenticated
using (
  bucket_id = 'attachments'
  and auth.uid() in (
    select m.user_id
    from public.session_participants sp
    join public.actors a    on a.id = sp.actor_id
    join public.members  m  on m.id = a.id
    where sp.session_id::text = split_part(name, '/', 2)
      and m.user_id is not null
  )
);
