/** Music and crowd axes for the ingest vibe check. Jev scores each 0–1. */

export type VibeAxis = {
  key: string;
  kind: "music" | "crowd";
  label: string;
  instructions: string;
};

export const MUSIC_AXES: VibeAxis[] = [
  {
    key: "house",
    kind: "music",
    label: "house / disco",
    instructions:
      "Is the music house, disco, groovy club, or soulful dance? Not techno warehouse, not hip-hop, not top 40.",
  },
  {
    key: "techno",
    kind: "music",
    label: "techno / underground",
    instructions:
      "Is the music techno, warehouse, or underground electronic? Not house disco, not commercial EDM radio.",
  },
  {
    key: "hiphop",
    kind: "music",
    label: "hip-hop / R&B",
    instructions: "Is the music hip-hop, rap, or R&B? Not house, not afro, not latin.",
  },
  {
    key: "afro",
    kind: "music",
    label: "afro / caribbean",
    instructions:
      "Is the music afrobeats, amapiano, dancehall, soca, or bashment? That crowd is usually different from a house or hip-hop room.",
  },
  {
    key: "latin",
    kind: "music",
    label: "latin / reggaeton",
    instructions: "Is the music latin, reggaeton, salsa, dembow, or Brazilian funk?",
  },
  {
    key: "live",
    kind: "music",
    label: "live / indie",
    instructions: "Is this a live band, indie, rock, jazz, or singer-songwriter night more than a DJ club?",
  },
  {
    key: "pop",
    kind: "music",
    label: "pop / commercial",
    instructions: "Is this top 40, commercial club, or radio EDM rather than a specific scene?",
  },
];

export const CROWD_AXES: VibeAxis[] = [
  {
    key: "local",
    kind: "crowd",
    label: "local / scene",
    instructions:
      "Is this for locals, regulars, or a specific music scene? Not a tourist bottle-service room.",
  },
  {
    key: "bottle",
    kind: "crowd",
    label: "tourist / bottle service",
    instructions: "Is this tourist, bottle service, velvet rope, or table-service club energy?",
  },
  {
    key: "queer",
    kind: "crowd",
    label: "queer nightlife",
    instructions: "Is this a queer, gay, lesbian, or trans nightlife crowd?",
  },
  {
    key: "grown",
    kind: "crowd",
    label: "grown",
    instructions: "Is this a grown, 25-plus crowd rather than a college or very young night?",
  },
];

export const VIBE_AXES: VibeAxis[] = [...MUSIC_AXES, ...CROWD_AXES];

const AXIS_FLOOR = 0.4;

export function pickVibe(
  scores: Record<string, number>,
  existingTags: string[] = [],
): { music: string; crowd: string; tags: string[]; vibe: string } {
  const music = bestLabel(MUSIC_AXES, scores) ?? "mixed";
  const crowd = bestLabel(CROWD_AXES, scores) ?? "mixed";
  const tags = new Set(existingTags.map((tag) => tag.toLowerCase()));
  for (const axis of VIBE_AXES) {
    if ((scores[axis.key] ?? 0) >= AXIS_FLOOR) tags.add(axis.label);
  }
  tags.add(music);
  tags.add(crowd);
  const vibe = `${music} night. ${crowd} crowd.`;
  return { music, crowd, tags: [...tags], vibe };
}

function bestLabel(axes: VibeAxis[], scores: Record<string, number>): string | null {
  let best: VibeAxis | null = null;
  let bestScore = AXIS_FLOOR;
  for (const axis of axes) {
    const score = scores[axis.key] ?? 0;
    if (score >= bestScore) {
      best = axis;
      bestScore = score;
    }
  }
  return best?.label ?? null;
}
