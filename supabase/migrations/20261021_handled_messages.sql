-- One row per inbound message id. During a Render deploy the old and new workers
-- both receive every message; whichever inserts the id first answers it.
create table if not exists public.handled_messages (
  id text primary key,
  created_at timestamptz not null default now()
);

alter table public.handled_messages enable row level security;
