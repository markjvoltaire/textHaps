export async function runActor(actor: string, input: Record<string, unknown>): Promise<unknown[]> {
  const token = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("missing APIFY_TOKEN");

  const endpoint = new URL(`https://api.apify.com/v2/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items`);
  endpoint.searchParams.set("timeout", "180");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? JSON.stringify((payload as { error: unknown }).error)
        : `apify ${response.status}`;
    throw new Error(message);
  }
  return Array.isArray(payload) ? payload : [];
}
