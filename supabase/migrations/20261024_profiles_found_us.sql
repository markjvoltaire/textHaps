-- How they found out about Haps, asked first in onboarding.
alter table public.profiles add column if not exists found_us text;
-- People who joined before onboarding asked aren't asked out of the blue.
update public.profiles set found_us = 'joined before haps asked' where found_us is null and created_at < '2026-10-25';
