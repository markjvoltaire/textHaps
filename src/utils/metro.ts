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
};

/** Collapses a city or neighborhood ("Brooklyn", "Miami Beach") to the metro listings are stored under. */
export function metroFor(city: string): string {
  const slug = city.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [metro, aliases] of Object.entries(METRO_ALIASES)) {
    if (aliases.some((alias) => slug === alias || slug.includes(alias))) return metro;
  }
  return slug;
}
