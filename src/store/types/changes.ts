import type { ChangeOutcome, RejectReason } from "../../domain/enums.js";

/** technical/updates.md, "Step 1. Claim check and gather". A fact with every version, the agent text (changeReasoning, summary) removed. */
export interface FactMaterial {
  factId: string;
  isDeleted: boolean;
  versions: {
    seq: number;
    header: string;
    content: string;
    justification: string;
    references: string[];
    isDeleted: boolean;
    created: number;
  }[];
}

/** technical/updates.md, "Step 5. Draft". One fact version the change set writes. */
export interface FactDraft {
  /** Absent for a new fact. */
  factId?: string;
  header: string;
  content: string;
  /** Set by the pipeline step, never by a model. */
  justification: string;
  /** Ids of the facts this version depends on. */
  references: string[];
  isDeleted?: boolean;
}

/** technical/updates.md, "Step 5. Draft". The result of the update pipeline for one request. */
export interface ChangeSet {
  outcome: ChangeOutcome;
  /** Required when rejected. */
  rejectReason?: RejectReason;
  /** Required when duplicate. */
  duplicateOf?: string;
  /** Required when split: the claims, one child submission each (technical/submit.md, "Split of a compound submission"). */
  claims?: string[];
  summary: string;
  changeReasoning: string;
  facts: FactDraft[];
}

/** technical/updates.md, "Write transaction". A fact version as the index hook sees it. */
export interface IndexedVersion {
  /** `fact_versions.id`, the key of `fact_versions_fts` and `fact_versions_vec`. */
  versionId: number;
  factId: string;
  seq: number;
  header: string;
  content: string;
  isDeleted: boolean;
}

/** technical/updates.md, "Write transaction". What the write transaction hands to the index. */
export interface IndexChange {
  seq: number;
  versions: IndexedVersion[];
}
