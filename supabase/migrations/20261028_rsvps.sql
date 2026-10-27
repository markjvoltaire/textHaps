-- Haps RSVPs for people: a browser agent fills the event's free RSVP form with their name and email.
create table if not exists public.rsvps (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  save_id uuid not null references public.saves (id) on delete cascade,
  url text not null,
  -- Where to text them about it: the conversation they asked from, on the platform that serves it.
  platform text not null,
  space_id text not null,
  -- needs_input: waiting on them for something the form asks that Haps doesn't have.
  status text not null default 'running'
    check (status in ('running', 'needs_input', 'done', 'needs_user', 'failed')),
  -- Why it stopped short, from a fixed list, so a page can't put its own words in Haps's text.
  reason text check (reason in ('payment', 'sold_out', 'closed', 'needs_more_info', 'captcha', 'blocked', 'error')),
  -- What Haps asked them for, from a fixed list so the text it sends is Haps's own.
  asking text check (asking in ('code', 'full_name', 'email', 'phone', 'address', 'date_of_birth', 'other')),
  -- What they texted back, held until the agent picks it up, then cleared.
  answer text,
  -- Bumped every step. A stale one means the worker died mid-run (a deploy).
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- One run per event at a time, so "rsvp me" twice doesn't fill the form twice.
create unique index if not exists rsvps_active_save_idx on public.rsvps (save_id) where status in ('running', 'needs_input');
create index if not exists rsvps_profile_idx on public.rsvps (profile_id, created_at desc);
create index if not exists rsvps_active_idx on public.rsvps (heartbeat_at) where status in ('running', 'needs_input');

alter table public.rsvps enable row level security;
