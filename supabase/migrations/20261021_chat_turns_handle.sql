-- Copy the sender's handle (phone number or iMessage email) onto each turn so the
-- table shows who texted without a join through profiles.
alter table public.chat_turns add column if not exists handle text;

update public.chat_turns t
set handle = p.platform_user_id
from public.profiles p
where p.id = t.profile_id
  and t.handle is null;
