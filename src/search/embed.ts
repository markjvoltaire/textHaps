import { AutoModel, AutoTokenizer, type PreTrainedModel, type PreTrainedTokenizer } from "@huggingface/transformers";

// EmbeddingGemma: multilingual, so a Spanish ask matches English recs. q4 holds at about 400 MB;
// q8 climbed past 1 GB after a few searches, too much for the 512 MB worker.
const MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const DTYPE = "q4";
// The model makes 768 numbers, trained so the first 384 work on their own. That fits the existing columns.
const DIMS = 384;
// It reads about 2,048 tokens; the name and vibe come first so a long description can't push them out.
const MAX_CHARS = 6000;

let loaded: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | undefined;

/** Loads the model once (about 200 MB the first time, then from cache) and keeps it in memory. */
export function loadEmbedder() {
  loaded ??= Promise.all([AutoTokenizer.from_pretrained(MODEL), AutoModel.from_pretrained(MODEL, { dtype: DTYPE })]).then(
    ([tokenizer, model]) => ({ tokenizer, model }),
    (err: unknown) => {
      // Not kept, so the next search tries again instead of failing forever.
      loaded = undefined;
      throw err;
    },
  );
  return loaded;
}

async function vector(text: string): Promise<number[]> {
  const { tokenizer, model } = await loadEmbedder();
  const { sentence_embedding } = await model(await tokenizer([text.slice(0, MAX_CHARS)], { padding: true }));
  const full = Array.from(sentence_embedding.data as Float32Array);
  // Cut to 384 and scale back to length 1, so cosine distance stays comparable.
  const cut = full.slice(0, DIMS);
  const length = Math.hypot(...cut);
  return cut.map((value) => value / length);
}

/** A search, embedded with the query prompt the model was trained on. */
export function embedQuery(text: string): Promise<number[]> {
  return vector(`task: search result | query: ${text}`);
}

/** Something to be found (a rec), embedded with the document prompt. */
export function embedDocument(text: string, title?: string | null): Promise<number[]> {
  return vector(`title: ${title?.trim() || "none"} | text: ${text}`);
}
