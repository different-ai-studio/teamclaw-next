-- Fix: an agent could not update its own row (e.g. advertising agent_types)
-- when its visibility was 'personal' and owner_member_id was not itself.
--
-- Root cause: `agents_self_update` (UPDATE) is gated on app.is_current_agent(id)
-- and passes, but PostgreSQL applies the SELECT policy when locating rows for an
-- UPDATE. `agents_select_if_visible` only exposed a row to team members who own
-- it (or team-visible agents), never to the agent itself. So a personal agent
-- whose owner_member_id is the inviting human actor could not SELECT — and thus
-- not UPDATE — its own row: the UPDATE matched 0 rows and the daemon's
-- agent_types advertise failed with "update did not apply".
--
-- An agent must always be able to see its own row. Add app.is_current_agent(id)
-- to the SELECT policy. Idempotent (drop-if-exists + create).

drop policy if exists agents_select_if_visible on public.agents;
create policy agents_select_if_visible on public.agents
for select to authenticated using (
  app.is_current_agent(agents.id)
  or exists (
    select 1
      from public.actors a
     where a.id = agents.id
       and app.is_team_member(a.team_id)
       and (
         agents.visibility = 'team'
         or agents.owner_member_id = app.current_actor_id_for_team(a.team_id)
       )
  )
);
