-- Curated recs: places and recurring nights Haps vouches for, searched by meaning.
-- Drafts come from editorial sources and are only used once someone approves them.
create table if not exists public.recs (
  id uuid primary key default gen_random_uuid(),
  metro text not null,
  -- Normalized name, so "The Shrine" and "THE SHRINE" are one rec per metro.
  key text not null,
  name text not null,
  category text not null,
  neighborhood text,
  address text,
  url text,
  why text not null,
  best_for text[] not null default '{}',
  vibe text,
  music text,
  crowd text,
  price text,
  -- For recurring nights: "Saturdays", "monthly, Sundays".
  schedule text,
  vouched_by text[] not null default '{}',
  sources text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  last_checked timestamptz,
  embedding extensions.vector(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (metro, key)
);

create index if not exists recs_metro_status_idx on public.recs (metro, status);
create index if not exists recs_embedding_idx on public.recs using hnsw (embedding extensions.vector_cosine_ops);

alter table public.recs enable row level security;

-- Closest approved recs to a search, optionally limited to a metro and categories.
create or replace function public.match_recs(
  query_embedding extensions.vector(384),
  match_metro text default null,
  match_categories text[] default null,
  match_count int default 5
)
returns table (id uuid, name text, category text, neighborhood text, why text, url text, distance double precision)
language sql stable
set search_path = public, extensions
as $$
  select r.id, r.name, r.category, r.neighborhood, r.why, r.url, r.embedding <=> query_embedding as distance
  from public.recs r
  where r.status = 'approved'
    and r.embedding is not null
    and (match_metro is null or r.metro = match_metro)
    and (match_categories is null or r.category = any(match_categories))
  order by r.embedding <=> query_embedding
  limit match_count;
$$;
