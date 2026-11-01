import type { SearchHitKind } from "../../domain/enums.js";

/** technical/lookup.md, "getFact". One version of a fact. */
export interface FactVersion {
  seq: number;
  header: string;
  content: string;
  justification: string;
  /** Ids of the facts this fact version depends on. */
  references: string[];
  changeReasoning: string;
  isDeleted: boolean;
  /** Creation time, in ms since the epoch. */
  created: number;
}

/**
 * technical/lookup.md, "getFact", consumer form: a fact with its current version.
 */
export interface FactResult {
  id: string;
  isDeleted: boolean;
  /** Confidence, 0 to 1. */
  confidence: number;
  current: FactVersion;
}

/** technical/updates.md, "Store API reads for the update agent", agent form: a fact with every version, newest first. */
export interface FactHistoryResult {
  id: string;
  isDeleted: boolean;
  confidence: number;
  factVersions: FactVersion[];
}

/**
 * technical/lookup.md, "search", consumer form: one search hit, a fact.
 */
export interface SearchResult {
  kind: SearchHitKind.Fact;
  id: string;
  header: string;
  confidence: number;
  score: number;
}

/** technical/updates.md, "Store API reads for the update agent", agent form: one search hit; a fact hit names the version that matched best. */
export interface AgentSearchResult {
  kind: SearchHitKind.Fact;
  id: string;
  factId: string;
  factVersionId: number;
  seq: number;
  isDeleted: boolean;
  header: string;
  confidence: number;
  score: number;
}
