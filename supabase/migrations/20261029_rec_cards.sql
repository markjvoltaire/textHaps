-- Each photo in a rec carousel, by the iMessage id it went out with, so a reply to one photo
-- ("this one") tells Haps which rec they mean.
create table if not exists public.rec_cards (
  message_id text primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- Null once the rec is deleted; the name still says what the photo was.
  rec_id uuid references public.recs (id) on delete set null,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.rec_cards enable row level security;
