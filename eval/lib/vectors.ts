// Vector helper that the bulk test shares: the embedding of a long list of texts.
import { embed } from "../../src/embed/index.js";

/** The texts embedded in one call. */
const EMBED_CHUNK = 64;

/**
 * Embeds a list of texts in chunks of `EMBED_CHUNK`.
 *
 * @param texts - the texts, each inside the embedder window
 * @returns one vector per text, in order
 * @sideEffects runs the embedder
 */
export async function embedAll(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK) out.push(...(await embed(texts.slice(i, i + EMBED_CHUNK))));
  return out;
}
