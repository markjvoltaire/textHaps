create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_id text,
  url text,
  title text not null,
  description text not null default '',
  city text not null,
  venue text,
  starts_at timestamptz,
  ends_at timestamptz,
  image_url text,
  tags text[] not null default '{}',
  vibe text,
  keep_score double precision,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, url)
);

create index if not exists listings_city_starts_idx
  on public.listings (city, starts_at);

create index if not exists listings_keep_starts_idx
  on public.listings (keep_score, starts_at)
  where keep_score is not null;

alter table public.listings enable row level security;
