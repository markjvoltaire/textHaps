-- Saved events carry when and where, so Haps can remind people before they happen.
alter table public.saves
  add column if not exists starts_at timestamptz,
  -- The day in the venue's own time zone. Set even when the start time isn't known.
  add column if not exists event_date date,
  add column if not exists venue text;

-- Texts Haps sends first: a check-in a couple of days out, and a heads-up the day of.
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- Dropping a save drops its reminders, so "not going anymore" stops them.
  save_id uuid not null references public.saves (id) on delete cascade,
  kind text not null check (kind in ('check_in', 'day_of')),
  send_at timestamptz not null,
  -- Where to text them: the conversation the save came from, on the platform that serves it.
  platform text not null,
  space_id text not null,
  -- Set when a worker claims it, so two workers overlapping in a deploy send it once.
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- Saving the same event again moves its reminders instead of adding more.
create unique index if not exists reminders_save_kind_idx on public.reminders (save_id, kind);
create index if not exists reminders_due_idx on public.reminders (send_at) where sent_at is null;

alter table public.reminders enable row level security;
