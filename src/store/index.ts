// The public surface of the Store API (technical/README.md, "Components"): the one door to the SQLite file.
export * from "./types/index.js";
export { openStore, openStoreFor, closeStore, StoreMismatchError } from "./open.js";
export { backupDatabase, readSchemaVersion, readSourceContent } from "./backup.js";
export { anonymizeStore, rebuildFullText, listTextCells, compactStore } from "./publication.js";
export { SCHEMA_VERSION, OLDEST_SCHEMA_VERSION } from "./schema.js";
export { getFact, getFactMaterial, getDependents, isLiveFact, isFactId } from "./read.js";
export { search, ftsQuery, VEC_CANDIDATES, RRF_CANDIDATES } from "./search/index.js";
export { profileSearch } from "./search/profile.js";
// The console reads of technical/console.md, "Store API additions".
export { listFacts, exportFacts, getFactDetail } from "./console/facts.js";
export { namesOf, type IdNames } from "./console/names.js";
export { listRequests, getRequestDetail, versionsOfChange } from "./console/requests.js";
export { listActivity, versionWriteKind, type ActivityItem } from "./console/activity.js";
export { listChanges } from "./console/changes.js";
export { sampleFacts } from "./console/sample.js";
export { InvalidPageError, MAX_LIMIT } from "./console/paging.js";
export { versionText } from "./indexer.js";
export { checkIndex, reindex } from "./maintenance.js";
export { MIN_CLAIMS_TO_SPLIT, applyChange, applyChangeSync, type ApplyResult } from "./write.js";
// The high volume mode (technical/updates.md, "High volume mode").
export {
  StaleChangeError,
  clearBatchNow,
  clearBatchStartSeq,
  factsChangedSince,
  readBatchNow,
  writeBatchNow,
  olderFirst,
  stagedFacts,
  readBatchProgress,
  readBatchStartSeq,
  writeBatchProgress,
  writeBatchStartSeq,
  type BatchProgress,
  type FreshCheck,
} from "./batch.js";
export {
  LiveMovedError,
  clearStaging,
  countStagedChanges,
  openOverlay,
  promoteStaging,
  resetStaging,
  type PriorQueryCheck,
  type PromotedRequest,
} from "./staging.js";
export { seedChange, type SeedResult } from "./seed.js";
// The cleanup (technical/cleanup.md, "Cleanup").
export { cleanupCandidates } from "./cleanup/candidates.js";
export { nearestAmong, nearestLiveFacts } from "./cleanup/duplicate-facts.js";
export {
  CLEANUP_CAP,
  CLEANUP_EVERY,
  CLEANUP_EVERY_MAX,
  CLEANUP_EVERY_MIN,
  CLEANUP_FINDERS,
  DUPLICATE_FACT_NEIGHBORS,
  REPAIRS_TO_SHORTEN,
  nextInterval,
} from "./cleanup/limits.js";
export {
  verdictSubject,
  writeVerdicts,
  isCovered,
  readCleanupSeq,
  writeCleanupSeq,
  readCleanupFull,
  writeCleanupFull,
  readCleanupEvery,
  writeCleanupEvery,
  readCleanupPending,
  writeCleanupPending,
  countRepairs,
  hasOpenRepairs,
  highestChangeSeq,
  countWritesSince,
  type CleanupEvery,
  type CleanupSeqs,
} from "./cleanup/state.js";
export {
  countFacts,
  countLiveFacts,
  countQueued,
  countRetrievals,
  countVersions,
  firstSeqOfFacts,
  getChangeForRequest,
  listCurrentFacts,
  listRequestIds,
  listRequestIdsWithOutcome,
  queueStats,
  type CurrentFactRow,
  type QueueStats,
} from "./stats.js";
export { recordRetrieval } from "./retrievals.js";
// Schema 7: the sessions, the search log and the model call rows (technical/lookup.md, "Search log and sessions", technical/updates.md, "Model call rows").
export { openSession, touchSession, endSession, endOpenSessions } from "./sessions.js";
export { getSearchQuery, recordSearch, resolveRef, searchAndLog } from "./searchLog.js";
export { recordModelCall, modelCallTotals, type ModelCallInput } from "./modelCalls.js";
// Schema 9: the tool calls of the endpoints (technical/deployment.md, "Endpoint counters").
export {
  recordToolCall,
  pruneToolCalls,
  toolCallStats,
  TOOL_CALL_RETENTION_MS,
  RECENT_WINDOW_MS,
  type ToolCallCount,
  type ToolCallBucket,
  type ToolCallStats,
} from "./toolCalls.js";
// The reads for the signals and the jobs (technical/console.md, "Store API reads for the signals").
export {
  spanBounds,
  growthSeries,
  readsPerSearch,
  searchMisses,
  tokenCost,
  type SpanBounds,
  GROWTH_STRETCHES,
  type GrowthStretch,
  type SearchMisses,
} from "./signals.js";
export { listSearchReads, type SearchRead } from "./searchReads.js";
export { queueLengthSeries, requestThroughput, THROUGHPUT_HOURS, type RequestThroughput } from "./throughput.js";
export { jobRows, type CleanupJobRow, type JobRequest } from "./jobs.js";
export { confidence, confidences, usefulness, decay } from "./scores.js";
export { readQueuePause, setQueuePause, clearQueuePause, type QueuePause } from "./queuePause.js";
export {
  writeWorkerStatus,
  readWorkerStatus,
  WORKER_STATUS_KEY,
  type WorkerCall,
  type WorkerStatus,
} from "./status.js";
export {
  enqueueRequest,
  enqueueOperatorEdit,
  enqueueCleanupRepair,
  enqueueCleanupRepairs,
  getRequest,
  takeNextRequest,
  takeRequest,
  queuedRepairIds,
  finishRequest,
  failAttempt,
  failRequest,
  releaseRequest,
  takeStagedRequest,
  getBatchRequest,
  releaseStagedRequest,
  resetRunning,
  listFailed,
  listRunning,
  queuePosition,
  peekQueue,
  countQueuedSubmissions,
  requeue,
  newId,
} from "./queue.js";
