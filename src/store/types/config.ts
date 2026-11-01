/** technical/lookup.md, "Scores": the weights of the confidence and usefulness scores. */
export interface Weights {
  /** The weight of the update itself in the confidence of its fact. */
  wUpdate: number;
  /** The weight of one `confirm` retrieval in confidence. */
  wConfirm: number;
  /** The weight of one `read` retrieval in confidence. */
  wRead: number;
  /** Half life of the confidence decay, in ms. */
  halfLifeConf: number;
  /** How far one unit of usefulness above the mean of the result list moves the score, as a fraction of it. */
  wUse: number;
  /** The most that usefulness moves a score, up or down, as a fraction of it: 0.1 is plus or minus 10 percent. */
  useBound: number;
  /** Half life of the usefulness decay, in ms. */
  halfLifeUse: number;
}

/** One day, in ms. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** technical/README.md, "Open settings": O1, O2. The default weights. */
export const DEFAULT_WEIGHTS: Weights = {
  wUpdate: 1.0,
  wConfirm: 1.0,
  wRead: 0,
  halfLifeConf: 30 * DAY_MS,
  wUse: 0.01,
  useBound: 0.1,
  halfLifeUse: 30 * DAY_MS,
};

/** technical/lookup.md, "Scores", technical/deployment.md, "Install and run" and technical/README.md, "Open settings": what `openStore` takes from the wiki config. */
export interface StoreConfig {
  embeddingModel: string;
  /** Vector dimension of the embedding model. Default `EMBEDDING_DIM` (O4). */
  embeddingDim?: number;
  weights?: Partial<Weights>;
  /** technical/README.md, "Open settings", O7. The most results of a consumer search. Default `DEFAULT_SEARCH_CAP`. */
  searchCap?: number;
  /** technical/lookup.md, "Retrieval pipeline", step 7. The largest cosine distance of a result that the full-text list lacks. Default `DEFAULT_RELEVANCE_FLOOR`. */
  relevanceFloor?: number;
  /** The most results of an agent search. Default `DEFAULT_AGENT_SEARCH_CAP`. */
  agentSearchCap?: number;
  /** The largest cosine distance at which two facts are neighbors for the duplicate fact check. Default `DEFAULT_NEIGHBOR_DISTANCE`; the wiki config does not set it. */
  neighborDistance?: number;
}

/** The default largest cosine distance (`1 - cosine`, no unit) at which two facts are neighbors. */
export const DEFAULT_NEIGHBOR_DISTANCE = 0.4;

/** technical/README.md, "Open settings", O7. The default cap of a consumer search, in results. */
export const DEFAULT_SEARCH_CAP = 10;
/** technical/README.md, "Open settings", O7. The default cap of an agent search, in results. */
export const DEFAULT_AGENT_SEARCH_CAP = 20;
/** technical/lookup.md, "Retrieval pipeline", step 7. The default relevance floor, as a cosine distance (`1 - cosine`, no unit; 0 is identical). */
export const DEFAULT_RELEVANCE_FLOOR = 0.31;
