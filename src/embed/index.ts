// The public surface of the embedding model folder.
export { cosineDistance } from "./distance.js";
export {
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  EMBED_WINDOW,
  countTokens,
  setEmbedder,
  embed,
  type EmbedFn,
} from "./embedder.js";
