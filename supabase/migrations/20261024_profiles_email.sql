-- For RSVPs: the user's email and full name, saved once they give them in the thread (email only after they confirm it).
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists full_name text;
