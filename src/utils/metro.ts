/** Neighborhoods and nearby cities that roll up to a supported metro. */
const METRO_ALIASES: Record<string, string[]> = {
  nyc: ["nyc", "new york", "manhattan", "brooklyn", "queens", "bronx", "staten island", "harlem", "williamsburg", "bushwick"],
  miami: [
    "miami",
    "miami beach",
    "south beach",
    "wynwood",
    "brickell",
    "little havana",
    "little haiti",
    "design district",
    "coconut grove",
    "coral gables",
    "doral",
    "hialeah",
    "fort lauderdale",
  ],
  la: [
    "los angeles",
    "la",
    "l a",
    "hollywood",
    "west hollywood",
    "weho",
    "silver lake",
    "echo park",
    "los feliz",
    "dtla",
    "downtown la",
    "arts district",
    "koreatown",
    "ktown",
    "highland park",
    "venice",
    "santa monica",
    "culver city",
    "west adams",
    "inglewood",
    "long beach",
    "pasadena",
  ],
};

const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

/** The supported metro a city or search names, or null if it names none. */
export function knownMetro(text: string): string | null {
  // Whole words only, so "la" matches "LA" or "Venice, LA" but never "Atlanta" or "Dallas".
  const words = ` ${slugOf(text)} `;
  for (const [metro, aliases] of Object.entries(METRO_ALIASES)) {
    if (aliases.some((alias) => words.includes(` ${alias} `))) return metro;
  }
  return null;
}

/** Collapses a city or neighborhood ("Brooklyn", "Miami Beach") to the metro recs are stored under. */
export function metroFor(city: string): string {
  return knownMetro(city) ?? slugOf(city);
}
