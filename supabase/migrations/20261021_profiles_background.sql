-- When we last set the Haps chat background for this person. Null means not yet,
-- so clearing it makes the next message set the background again.
alter table public.profiles add column if not exists background_set_at timestamptz;
