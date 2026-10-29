-- Claiming a reminder is split from sending it, so a failed send is tried again instead of lost.
alter table public.reminders
  -- Set while a worker is sending it. A claim older than 10 minutes is a worker that died mid-send.
  add column if not exists claimed_at timestamptz,
  add column if not exists attempts integer not null default 0,
  add column if not exists last_error text,
  -- Set when Haps gives up on it (past its deadline, out of attempts, or no longer needed).
  add column if not exists dropped_at timestamptz;

drop index if exists public.reminders_due_idx;
create index if not exists reminders_due_idx on public.reminders (send_at) where sent_at is null and dropped_at is null;
