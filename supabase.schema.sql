create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.muscle_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null check (category in ('primary', 'secondary')),
  created_at timestamptz not null default now()
);

create unique index if not exists muscle_groups_user_lower_name_unique
on public.muscle_groups (user_id, lower(name));

create table if not exists public.workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workout_date date not null,
  muscle_groups text[] not null default '{}',
  lifts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.muscle_groups enable row level security;
alter table public.workout_sessions enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
for update using (auth.uid() = id);

drop policy if exists "muscles_select_own" on public.muscle_groups;
create policy "muscles_select_own" on public.muscle_groups
for select using (auth.uid() = user_id);

drop policy if exists "muscles_insert_own" on public.muscle_groups;
create policy "muscles_insert_own" on public.muscle_groups
for insert with check (auth.uid() = user_id);

drop policy if exists "muscles_update_own" on public.muscle_groups;
create policy "muscles_update_own" on public.muscle_groups
for update using (auth.uid() = user_id);

drop policy if exists "muscles_delete_own" on public.muscle_groups;
create policy "muscles_delete_own" on public.muscle_groups
for delete using (auth.uid() = user_id);

drop policy if exists "sessions_select_own" on public.workout_sessions;
create policy "sessions_select_own" on public.workout_sessions
for select using (auth.uid() = user_id);

drop policy if exists "sessions_insert_own" on public.workout_sessions;
create policy "sessions_insert_own" on public.workout_sessions
for insert with check (auth.uid() = user_id);

drop policy if exists "sessions_update_own" on public.workout_sessions;
create policy "sessions_update_own" on public.workout_sessions
for update using (auth.uid() = user_id);

drop policy if exists "sessions_delete_own" on public.workout_sessions;
create policy "sessions_delete_own" on public.workout_sessions
for delete using (auth.uid() = user_id);
