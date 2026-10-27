-- After a saved event, Haps asks if they went and how it was.
alter table public.reminders drop constraint if exists reminders_kind_check;
alter table public.reminders
  add constraint reminders_kind_check check (kind in ('check_in', 'day_of', 'follow_up'));

-- Whether they went and what they thought, so what people with similar taste loved can be
-- recommended to others.
create table if not exists public.event_feedback (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  save_id uuid references public.saves (id) on delete set null,
  -- The rec it was, when it's in recs (a shared or verified event, or a curated night).
  rec_id uuid references public.recs (id) on delete set null,
  metro text,
  title text not null,
  url text,
  venue text,
  event_date date,
  went boolean not null,
  verdict text check (verdict in ('loved', 'liked', 'meh', 'bad')),
  -- What they said about it, in their words.
  feedback text,
  created_at timestamptz not null default now()
);

-- One answer per saved event; telling Haps again updates it.
create unique index if not exists event_feedback_save_idx on public.event_feedback (save_id) where save_id is not null;
create index if not exists event_feedback_profile_idx on public.event_feedback (profile_id, created_at desc);

alter table public.event_feedback enable row level security;

-- Events people with taste closest to this one went to and loved or liked, nearest taste first.
-- Their own feedback is left out, and so is anyone without a taste vector yet.
create or replace function public.match_loved_by_similar(
  query_embedding extensions.vector(384),
  exclude_profile uuid,
  match_metro text default null,
  match_count int default 5
)
returns table (
  title text, url text, venue text, event_date date, verdict text, feedback text,
  rec_id uuid, rec_name text, schedule text, distance double precision
)
language sql stable
set search_path = public, extensions
as $$
  select f.title, f.url, f.venue, f.event_date, f.verdict, f.feedback,
         r.id, r.name, r.schedule, p.taste_embedding <=> query_embedding as distance
  from public.event_feedback f
  join public.profiles p on p.id = f.profile_id
  left join public.recs r on r.id = f.rec_id
  where f.went
    and f.verdict in ('loved', 'liked')
    and f.profile_id <> exclude_profile
    and p.taste_embedding is not null
    and (match_metro is null or f.metro = match_metro)
  order by p.taste_embedding <=> query_embedding
  limit match_count;
$$;
