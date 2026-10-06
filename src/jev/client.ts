const JEV_URL = process.env.JEV_API_URL ?? "https://api.typesafe.ai/v1/systemone";

type NoulAnswer = {
  type: "noul";
  noul: number;
};

type JevResponse = {
  answers?: Record<string, NoulAnswer>;
};

export async function jevNoulScores(
  state: string,
  questions: Record<string, { type: "noul"; instructions: string }>,
): Promise<Record<string, number>> {
  const token = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!token) return {};

  const response = await fetch(JEV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.JEV_MODEL ?? "jev-latest",
      state,
      questions,
    }),
  });
  const payload = (await response.json()) as JevResponse;
  if (!response.ok) {
    throw new Error(`jev ${response.status}`);
  }

  const scores: Record<string, number> = {};
  for (const [id, answer] of Object.entries(payload.answers ?? {})) {
    if (answer?.type === "noul" && typeof answer.noul === "number") {
      scores[id] = answer.noul;
    }
  }
  return scores;
}
