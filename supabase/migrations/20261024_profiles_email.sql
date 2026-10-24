-- The user's email, saved only after they confirm it in the thread. Used to RSVP them to events.
alter table public.profiles add column if not exists email text;
