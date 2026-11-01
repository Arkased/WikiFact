import type Database from "better-sqlite3";
import type { ChangeSet, IndexChange } from "./changes.js";
import type { StoreConfig, Weights } from "./config.js";

/**
 * The hook for technical/updates.md, "Write transaction", step 6. `src/store/indexer.ts` implements it.
 *
 * `prepare` runs before the transaction (technical/updates.md, "Write transaction", step 1) and may be async: compute embeddings here.
 * It gets the change set with the deletion drafts already filled in
 * (header and content copied from the prior version), so the texts match the rows.
 * Its return value goes to `write` as `prepared`.
 *
 * `write` runs inside the write transaction, after the rows are inserted, and must be synchronous.
 * It inserts the new versions into `fact_versions_fts` and `fact_versions_vec`,
 * deletes and re-inserts `current_vec` rows.
 * A throw rolls back the whole change.
 *
 * `P` is the type `prepare` returns. `write` receives `undefined` when the caller skipped `prepare`.
 */
export interface IndexWriter<P = unknown> {
  prepare?(change: ChangeSet): Promise<P>;
  write(db: Database.Database, change: IndexChange, prepared: P | undefined): void;
}

/** The store handle: the open database, its resolved config and the index hook. */
export interface Store {
  db: Database.Database;
  config: Required<
    Pick<
      StoreConfig,
      "embeddingModel" | "embeddingDim" | "searchCap" | "agentSearchCap" | "relevanceFloor" | "neighborDistance"
    >
  >;
  weights: Weights;
  /** Replace to plug in another index. Default: `createIndexWriter()`, installed by `openStore`. */
  indexWriter: IndexWriter;
  /**
   * Set on the overlay store of a batch (`openOverlay` in `staging.ts`): its reads see the live wiki plus the staging tables,
   * and its writes go to the staging tables.
   */
  overlay?: boolean;
  /**
   * Set on the handle that a request of a batch runs on. The handle reads the live wiki; `applyChange` writes through this
   * overlay store, so the change goes to the staging tables and no request sees the staged change of another.
   */
  stageTo?: Store;
}
