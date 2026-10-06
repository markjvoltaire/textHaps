alter table public.listings
  add column if not exists music text,
  add column if not exists crowd text,
  add column if not exists vibe_scores jsonb not null default '{}'::jsonb;
