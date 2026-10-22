-- When we sent this person the Haps contact card (name + icon). Null means not yet.
alter table public.profiles add column if not exists contact_card_sent_at timestamptz;
