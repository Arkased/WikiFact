/**
 * Computes the cosine distance of two vectors.
 *
 * @param a - the first vector
 * @param b - the second vector, of the same length
 * @returns 0 for equal directions, 1 for orthogonal or zero vectors, up to 2 for opposite ones
 * @sideEffects none
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 1 : 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
