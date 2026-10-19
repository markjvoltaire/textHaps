create table if not exists public.chat_turns (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- History reads the latest turns per profile; the rate limit counts recent user turns.
create index if not exists chat_turns_profile_created_idx
  on public.chat_turns (profile_id, created_at desc);

alter table public.chat_turns enable row level security;
