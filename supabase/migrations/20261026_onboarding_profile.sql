-- Onboarding learns ten things about someone. The facts Haps filters on live on the profile;
-- each taste is its own signal with where it came from and how sure Haps is.

alter table public.profiles
  add column if not exists neighborhoods text,
  add column if not exists travel text,
  add column if not exists budget text,
  add column if not exists going_out text,
  add column if not exists social text,
  add column if not exists discovery_goal text,
  add column if not exists taste_embedding extensions.vector(384),
  add column if not exists taste_embedded_at timestamptz;

comment on column public.profiles.neighborhoods is 'Neighborhoods they like going out in, in their words.';
comment on column public.profiles.travel is 'How far they will go, e.g. stays close, will travel for something worth it.';
comment on column public.profiles.budget is 'A normal night out for them, e.g. $40-80 per person, more for something special.';
comment on column public.profiles.going_out is 'When they go out and how they plan, e.g. fridays late, decides day of.';
comment on column public.profiles.social is 'Who they usually go out with, e.g. the crew, date nights, solo.';
comment on column public.profiles.discovery_goal is 'What they want Haps to make better, e.g. hidden gems, meeting people.';
comment on column public.profiles.taste_embedding is 'Their taste as one vector, built from their signals, to rank rec searches.';

alter table public.taste_signals
  add column if not exists category text,
  add column if not exists confidence real not null default 1,
  add column if not exists evidence text;

alter table public.taste_signals drop constraint if exists taste_signals_source_check;
alter table public.taste_signals
  add constraint taste_signals_source_check check (source = any (array['explicit', 'inferred', 'behavior']));

alter table public.taste_signals drop constraint if exists taste_signals_category_check;
alter table public.taste_signals
  add constraint taste_signals_category_check check (
    category is null
    or category = any (array['activity', 'music', 'food', 'scene', 'vibe', 'social', 'timing', 'place', 'goal', 'other'])
  );

alter table public.taste_signals drop constraint if exists taste_signals_confidence_check;
alter table public.taste_signals
  add constraint taste_signals_confidence_check check (confidence > 0 and confidence <= 1);
