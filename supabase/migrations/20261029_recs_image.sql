-- The picture a rec is sent with, so a first rec can go out as a swipeable carousel (#56).
-- image_url is Haps's own copy in the rec-images bucket, not the venue's, so a site going down or
-- blocking downloads doesn't break the send. image_source is the page it came from.
alter table recs add column if not exists image_url text;
alter table recs add column if not exists image_source text;
-- When an image was last looked for, set on a miss too, so a rec with no good picture isn't searched every run.
alter table recs add column if not exists image_checked_at timestamptz;

insert into storage.buckets (id, name, public)
values ('rec-images', 'rec-images', true)
on conflict (id) do nothing;
