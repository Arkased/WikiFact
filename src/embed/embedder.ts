import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "../paths.js";

/** technical/README.md, "Open settings", O4. The embedding model, by its Hugging Face id. */
export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
/** The number of dimensions of one embedding vector. */
export const EMBEDDING_DIM = 384;
/** The input window of the model, in tokens (technical/lookup.md, "search"). */
export const EMBED_WINDOW = 512;

/** An embedder: maps texts to one vector each, in input order. */
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

/** How many texts go to the model in one call. */
const BATCH = 32;

/**
 * Where the model files are cached: `.cache/models` under the project root inside a git checkout, otherwise
 * `<home>/.wikifact/models` (an installed package folder can be read-only).
 *
 * @returns the absolute cache directory
 * @sideEffects reads the file system
 */
function cacheDir(): string {
  const root = projectRoot();
  if (existsSync(join(root, ".git"))) return join(root, ".cache", "models");
  return join(homedir(), ".wikifact", "models");
}

/** Where the model files are cached. */
const CACHE_DIR = cacheDir();

type Extractor = (
  texts: string[],
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;
type Tokenizer = (text: string, opts?: Record<string, unknown>) => { input_ids: { dims: number[] } };

let pipelinePromise: Promise<Extractor> | undefined;
let tokenizerPromise: Promise<Tokenizer> | undefined;

async function transformers() {
  const t = await import("@huggingface/transformers");
  t.env.cacheDir = CACHE_DIR;
  return t;
}

function getPipeline(): Promise<Extractor> {
  const p = (pipelinePromise ??= (async () => {
    const t = await transformers();
    return (await t.pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "fp32" })) as unknown as Extractor;
  })());
  p.catch(() => {
    if (pipelinePromise === p) pipelinePromise = undefined;
  });
  return p;
}

function getTokenizer(): Promise<Tokenizer> {
  const p = (tokenizerPromise ??= (async () => {
    const t = await transformers();
    return await t.AutoTokenizer.from_pretrained(EMBEDDING_MODEL);
  })());
  p.catch(() => {
    if (tokenizerPromise === p) tokenizerPromise = undefined;
  });
  return p;
}

/**
 * Embeds texts with the real model: bge-small, in-process, normalized, 384 dimensions.
 *
 * @param texts - the texts to embed
 * @returns one vector per text, in input order; an empty list for an empty input, without loading the model
 * @sideEffects on first use downloads the model into the cache directory (see `cacheDir`) and keeps it in module state; sets
 *   the transformers `env.cacheDir`; later calls read the cache from disk
 */
async function embedReal(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getPipeline();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await extractor(batch, { pooling: "cls", normalize: true });
    const dim = res.dims[res.dims.length - 1];
    for (let j = 0; j < batch.length; j++) out.push(Float32Array.from(res.data.subarray(j * dim, (j + 1) * dim)));
  }
  return out;
}

/**
 * Counts the tokens of a text with the model tokenizer, special tokens included, without truncation.
 * The `search` input check of technical/lookup.md, "search" compares the count with `EMBED_WINDOW`.
 *
 * @param text - the text to tokenize
 * @returns the token count
 * @sideEffects on first use downloads the tokenizer into `.cache/models` and keeps it in module state; later calls
 *   read the cache from disk
 */
export async function countTokens(text: string): Promise<number> {
  const tok = await getTokenizer();
  const enc = tok(text, { truncation: false, add_special_tokens: true });
  const dims = enc.input_ids.dims;
  return dims[dims.length - 1];
}

// The embedder in use. The index writer and `search` read it. Default: the real model.
let current: EmbedFn = embedReal;

/**
 * Sets the embedder in use. This is the single injection point for tests and stub modes.
 *
 * @param fn - the embedder to use, or `null` to go back to the real model (`embedReal`)
 * @sideEffects replaces the module-level embedder for every later `embed` call in the process
 */
export function setEmbedder(fn: EmbedFn | null): void {
  current = fn ?? embedReal;
}

/**
 * Embeds texts with the embedder in use (the real model unless `setEmbedder` swapped it).
 *
 * @param texts - the texts to embed
 * @returns one vector per text, in input order
 * @sideEffects whatever the embedder in use does; the real model may download and load files
 */
export function embed(texts: string[]): Promise<Float32Array[]> {
  return current(texts);
}
