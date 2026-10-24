-- Listings ingest was removed: search comes from recs in Miami and LA, and from live search elsewhere.
-- Saves are by url only now, so their link to a listing goes too.
drop function if exists public.match_listings(extensions.vector, text, timestamptz, timestamptz, integer);
alter table public.saves drop column if exists listing_id;
drop table if exists public.listings;
