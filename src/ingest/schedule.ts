import { runIngest } from "./run.ts";

export function startIngestLoop(): void {
  if (!process.env.APIFY_TOKEN && !process.env.APIFY_API_TOKEN) {
    console.log("[ingest] skipped, no APIFY_TOKEN");
    return;
  }
  const intervalMs = Number(process.env.INGEST_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  const delayMs = Number(process.env.INGEST_DELAY_MS ?? 20_000);
  const tick = () => {
    runIngest().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ingest] loop failed: ${msg}`);
    });
  };
  console.log(`[ingest] scheduled every ${Math.round(intervalMs / 60000)}m`);
  setTimeout(tick, delayMs);
  setInterval(tick, intervalMs);
}
