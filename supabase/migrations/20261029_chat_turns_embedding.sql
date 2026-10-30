-- Long memory: each exchange (a user turn and Haps's reply to it) is embedded on the user turn,
-- so a new message can bring back older turns that mean the same thing.
alter table public.chat_turns add column if not exists embedding extensions.vector(384);
alter table public.chat_turns add column if not exists embedded_at timestamptz;

-- Search is always one person's turns, a few hundred rows at most, so an exact scan off the
-- existing (profile_id, created_at) index beats an HNSW index that would have to filter after.

-- The exchanges closest to a message, older than the turns already in Claude's history (the latest
-- skip_recent turns), each with the Haps reply that followed it. Only that profile's turns.
create or replace function public.match_chat_turns(
  match_profile uuid,
  query_embedding extensions.vector(384),
  skip_recent int default 20,
  match_count int default 5
)
returns table (id uuid, content text, reply text, created_at timestamptz, distance double precision)
language sql stable
set search_path = public, extensions
as $$
  with cutoff as (
    select t.created_at
    from public.chat_turns t
    where t.profile_id = match_profile
    order by t.created_at desc
    offset greatest(skip_recent - 1, 0)
    limit 1
  )
  select u.id, u.content, a.content as reply, u.created_at, u.embedding <=> query_embedding as distance
  from public.chat_turns u
  cross join cutoff
  left join lateral (
    select t.content
    from public.chat_turns t
    where t.profile_id = u.profile_id and t.role = 'assistant' and t.created_at > u.created_at
    order by t.created_at
    limit 1
  ) a on true
  where u.profile_id = match_profile
    and u.role = 'user'
    and u.embedding is not null
    and u.created_at < cutoff.created_at
  order by u.embedding <=> query_embedding
  limit match_count;
$$;

-- Server only: the worker calls it with the service role. Never from a client.
revoke execute on function public.match_chat_turns(uuid, extensions.vector, int, int) from public, anon, authenticated;
