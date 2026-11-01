/**
 * The relevance floor for a run with the fake embedder, as a cosine distance. The hash vectors have no meaning
 * at distance, and their cosine can be negative, so the floor is set to the largest distance there is (2): off.
 */
export const FAKE_EMBEDDER_FLOOR = 2;
