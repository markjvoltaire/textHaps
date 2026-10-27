/** Which Spectrum provider this worker runs: "imessage" in production, "terminal" for local testing. */
export const PROVIDER = (process.env.SPECTRUM_PROVIDER ?? "imessage").toLowerCase();
