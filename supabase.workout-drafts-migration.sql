begin;

create extension if not exists pgcrypto;

alter table public.workout_sessions add column if not exists source_draft_id uuid;

drop index if exists public.workout_sessions_source_draft_unique;
create unique index if not exists workout_sessions_source_draft_unique
on public.workout_sessions (user_id, source_draft_id);

create table if not exists public.workout_drafts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  workout_date date not null,
  muscle_groups text[] not null default '{}',
  lifts jsonb not null default '[]'::jsonb,
  lift_builder jsonb not null default '{}'::jsonb,
  current_view text not null default 'workout' check (current_view in ('dashboard', 'workout')),
  updated_at timestamptz not null default now()
);

alter table public.workout_drafts add column if not exists id uuid default gen_random_uuid();
update public.workout_drafts set id = gen_random_uuid() where id is null;
alter table public.workout_drafts alter column id set not null;
alter table public.workout_drafts enable row level security;

drop policy if exists "drafts_select_own" on public.workout_drafts;
create policy "drafts_select_own" on public.workout_drafts
for select using (auth.uid() = user_id);

drop policy if exists "drafts_insert_own" on public.workout_drafts;
create policy "drafts_insert_own" on public.workout_drafts
for insert with check (auth.uid() = user_id);

drop policy if exists "drafts_update_own" on public.workout_drafts;
create policy "drafts_update_own" on public.workout_drafts
for update using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "drafts_delete_own" on public.workout_drafts;
create policy "drafts_delete_own" on public.workout_drafts
for delete using (auth.uid() = user_id);

create or replace function public.finalize_workout_draft()
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  draft public.workout_drafts%rowtype;
  new_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into draft
  from public.workout_drafts
  where user_id = auth.uid()
  for update;

  if not found then
    raise exception 'No active workout draft';
  end if;

  insert into public.workout_sessions (user_id, source_draft_id, workout_date, muscle_groups, lifts)
  values (draft.user_id, draft.id, draft.workout_date, draft.muscle_groups, draft.lifts)
  on conflict (user_id, source_draft_id) do update
  set source_draft_id = excluded.source_draft_id
  returning id into new_session_id;

  delete from public.workout_drafts where user_id = auth.uid();
  return new_session_id;
end;
$$;

revoke all on function public.finalize_workout_draft() from public;
grant execute on function public.finalize_workout_draft() to authenticated;

commit;
