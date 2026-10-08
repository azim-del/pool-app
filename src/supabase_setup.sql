-- PoolIQ — run once in Supabase → SQL Editor → New query → Run

-- 1. New table for maintenance tasks (one row per task, holds the last-done time)
create table if not exists maintenance_logs (
  task_id text primary key,
  last_done timestamptz not null default now()
);

-- 2. Row Level Security: allow the app (anon key) to read and write all three tables.
--    Without these policies, Supabase silently returns empty results / rejects saves.
alter table test_history     enable row level security;
alter table purchases        enable row level security;
alter table maintenance_logs enable row level security;

drop policy if exists "pooliq anon access" on test_history;
drop policy if exists "pooliq anon access" on purchases;
drop policy if exists "pooliq anon access" on maintenance_logs;

create policy "pooliq anon access" on test_history     for all to anon using (true) with check (true);
create policy "pooliq anon access" on purchases        for all to anon using (true) with check (true);
create policy "pooliq anon access" on maintenance_logs for all to anon using (true) with check (true);
