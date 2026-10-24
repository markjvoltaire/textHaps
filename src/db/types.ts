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
  /** The part of town they live in or usually head out from, e.g. "north miami". */
  area: string | null;
  email: string | null;
  /** First and last name for RSVPs; name stays what they go by. */
  full_name: string | null;
  background_set_at: string | null;
  contact_card_sent_at: string | null;
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
  url: string | null;
  title: string | null;
  note: string | null;
  created_at: string;
};
