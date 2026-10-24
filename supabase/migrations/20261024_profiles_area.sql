-- The part of town someone lives in or usually heads out from ("north miami"), so recs can be close to them.
alter table public.profiles add column if not exists area text;
