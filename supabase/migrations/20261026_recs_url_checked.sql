-- When Haps last looked up a rec's own website (Exa, verified by Jev). A rec with no site found
-- isn't searched again on every send, only after this gets old.
alter table public.recs add column if not exists url_checked_at timestamptz;

comment on column public.recs.url_checked_at is 'Last time Haps searched for this rec''s official site, found or not.';
