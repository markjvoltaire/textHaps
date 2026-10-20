-- Listings are searched by metro (nyc, miami), not the source's own city label,
-- so "Brooklyn" or "Miami Beach" rows still match.
alter table public.listings
  add column if not exists metro text;

-- Every listing so far came from the Miami ingest.
update public.listings set metro = 'miami' where metro is null;

create index if not exists listings_metro_starts_idx
  on public.listings (metro, starts_at)
  where keep_score is not null;
