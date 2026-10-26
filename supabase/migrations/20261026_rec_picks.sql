-- Which recs Haps sent someone, and which one they said they're going with (or passed on),
-- so we learn what people actually pick.
create table if not exists public.rec_picks (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- Null when they picked something that isn't in the recs table.
  rec_id uuid references public.recs (id) on delete set null,
  name text not null,
  -- recKey(name), to match "stamped" to "Stamped: AYA x Friends".
  rec_key text not null,
  url text,
  shown_at timestamptz,
  outcome text check (outcome in ('picked', 'passed')),
  outcome_at timestamptz,
  -- What they said about it, e.g. "going with the girls saturday".
  note text,
  created_at timestamptz not null default now()
);

create index if not exists rec_picks_profile_recent on public.rec_picks (profile_id, created_at desc);

alter table public.rec_picks enable row level security;
