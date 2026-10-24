-- Search listings by meaning: gte-small embeddings (384 numbers) of each listing's text.
create extension if not exists vector with schema extensions;

alter table public.listings
  add column if not exists embedding extensions.vector(384);

create index if not exists listings_embedding_idx
  on public.listings using hnsw (embedding extensions.vector_cosine_ops);

-- Closest listings to a search, optionally limited to a metro and a date window.
create or replace function public.match_listings(
  query_embedding extensions.vector(384),
  match_metro text default null,
  starts_after timestamptz default null,
  starts_before timestamptz default null,
  match_count int default 5
)
returns table (id uuid, title text, url text, starts_at timestamptz, vibe text, distance double precision)
language sql stable
set search_path = public, extensions
as $$
  select l.id, l.title, l.url, l.starts_at, l.vibe, l.embedding <=> query_embedding as distance
  from public.listings l
  where l.embedding is not null
    and (match_metro is null or l.metro = match_metro)
    and (starts_after is null or l.starts_at >= starts_after)
    and (starts_before is null or l.starts_at <= starts_before)
  order by l.embedding <=> query_embedding
  limit match_count;
$$;
