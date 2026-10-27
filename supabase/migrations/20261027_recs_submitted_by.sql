-- Event links people send Haps become rec drafts, so who sent each one is kept.
alter table public.recs
  add column if not exists submitted_by uuid references public.profiles (id) on delete set null;

comment on column public.recs.submitted_by is 'The user who sent Haps this link. Null for recs from editorial sources.';

-- Saved events only text people before them once they say yes to a reminder.
alter table public.saves
  add column if not exists remind boolean not null default false;
