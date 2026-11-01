import { EMBEDDING_DIM } from "../src/embed/index.js";

/** The embedding model name that a wiki built with `fakeEmbed` records, so that a wiki of fake vectors cannot pass for a real one. */
export const FAKE_EMBEDDING_MODEL = "fake-embedder";

/** Bits to shift a hash right before its sign bit is read. */
const SIGN_SHIFT = 16;
/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Embeds texts with a deterministic bag of hashed words, for tests and the stub modes of eval.
 *
 * @param texts - the texts to embed
 * @returns one normalized vector of `EMBEDDING_DIM` numbers per text, in input order
 * @sideEffects none
 */
export function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(texts.map(fakeVector));
}

/**
 * Builds the fake vector of one text: each lower-case word adds a signed unit to one slot, then the vector is
 * normalized.
 *
 * @param text - the text to embed; texts that share words give close vectors
 * @returns a unit vector of `EMBEDDING_DIM` numbers; `[1, 0, ...]` for a text without words
 * @sideEffects none
 */
export function fakeVector(text: string): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    const h = fnv1a(w);
    const slot = h % EMBEDDING_DIM;
    v[slot] = (v[slot] ?? 0) + ((h >>> SIGN_SHIFT) & 1 ? 1 : -1);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/**
 * Hashes a string with 32-bit FNV-1a.
 *
 * @param s - the string to hash
 * @returns the unsigned 32-bit hash
 * @sideEffects none
 */
function fnv1a(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}
