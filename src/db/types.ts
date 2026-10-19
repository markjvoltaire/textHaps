export type TasteKind = "like" | "dislike" | "constraint";
export type TasteSource = "explicit" | "inferred";

export type OnboardingField = "taste" | "city";

export type Profile = {
  id: string;
  platform: string;
  platform_user_id: string;
  name: string | null;
  date_of_birth: string | null;
  city: string | null;
  created_at: string;
};

export type EventRow = {
  id: string;
  title: string;
  description: string;
  city: string;
  neighborhood: string | null;
  venue: string | null;
  starts_at: string;
  ends_at: string | null;
  url: string | null;
  tags: string[];
  vibe: string | null;
  music?: string | null;
  crowd?: string | null;
  price_note: string | null;
  source: string;
  image_path: string | null;
  created_at: string;
};

export type TasteSignal = {
  id: string;
  profile_id: string;
  kind: TasteKind;
  label: string;
  weight: number;
  source: TasteSource;
  created_at: string;
};

export type SaveRow = {
  id: string;
  profile_id: string;
  event_id: string | null;
  url: string | null;
  title: string | null;
  note: string | null;
  created_at: string;
  event?: EventRow | null;
};
