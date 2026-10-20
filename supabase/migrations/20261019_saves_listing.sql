-- Recs now come from listings, not the old events test table, so saves point there.
alter table public.saves
  add column if not exists listing_id uuid references public.listings (id) on delete set null;

create unique index if not exists saves_profile_listing_idx
  on public.saves (profile_id, listing_id)
  where listing_id is not null;

-- A save needs something to point at: a listing, a legacy event, or a pasted link.
alter table public.saves drop constraint if exists saves_target_check;
alter table public.saves
  add constraint saves_target_check
  check (listing_id is not null or event_id is not null or url is not null);
