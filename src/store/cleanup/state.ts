// The state the cleanup keeps in the store (technical/storage.md, "Tables", technical/cleanup.md, "Cleanup"): the verdicts and the seq the last run saw.
import { z } from "zod";
import { ChangeOutcome, CleanupFinder, MetaKey, RequestKind, RequestStatus } from "../../domain/enums.js";
import { inList } from "../sql.js";
import { CLEANUP_EVERY, CLEANUP_EVERY_MAX, CLEANUP_EVERY_MIN, CLEANUP_FINDERS } from "./limits.js";
import type { Store } from "../types/index.js";

/**
 * Builds the `subject` of a verdict: the sorted fact ids of the candidate, joined by spaces.
 *
 * @param ids - the ids of the candidate
 * @returns the subject
 * @sideEffects none
 */
export function verdictSubject(ids: string[]): string {
  return [...ids].sort().join(" ");
}

/**
 * Writes a verdict row for each subject at the current sequence number: the model judged the candidate and it needed
 * no change. A verdict that exists is replaced.
 *
 * @param store - the open store with the write connection
 * @param finder - the finder whose candidates were judged
 * @param subjects - the subjects, from `verdictSubject`
 * @param now - the time of the verdicts, in ms since the epoch
 * @sideEffects one transaction on the store (the highest `changes.seq` is read; one upsert per subject)
 */
export function writeVerdicts(store: Store, finder: CleanupFinder, subjects: string[], now: number): void {
  const write = store.db.transaction(() => {
    const { seq } = store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes").get() as { seq: number };
    const upsert = store.db.prepare(
      `INSERT INTO cleanup_verdicts(finder, subject, seq, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(finder, subject) DO UPDATE SET seq = excluded.seq, at = excluded.at`,
    );
    for (const subject of subjects) upsert.run(finder, subject, seq, now);
  });
  write.immediate();
}

// A version above `seq` whose header or content differs from the version before it.
function factTextChanged(store: Store, ids: string[], seq: number): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 FROM (
         SELECT seq, header, content,
                LAG(header) OVER w AS prevHeader, LAG(content) OVER w AS prevContent
         FROM fact_versions WHERE fact_id IN (${inList(ids.length)})
         WINDOW w AS (PARTITION BY fact_id ORDER BY seq)
       ) WHERE seq > ? AND (prevHeader IS NULL OR prevHeader <> header OR prevContent <> content)`,
    )
    .get(...ids, seq);
  return row !== undefined;
}

/**
 * Tells whether a verdict covers a candidate: a verdict row exists and has not ended. A verdict ends only on what its
 * judge reads (design/cleanup.md, "No repeat check"):
 *
 * - duplicate fact (2 facts): the header or the content of 1 of the facts changes.
 *
 * @param store - the open store
 * @param finder - the finder of the candidate
 * @param subject - the subject, from `verdictSubject`
 * @returns true when the finder skips the candidate
 * @sideEffects none (reads)
 */
export function isCovered(store: Store, finder: CleanupFinder, subject: string): boolean {
  const ids = subject.split(" ");
  const rows = store.db
    .prepare("SELECT seq FROM cleanup_verdicts WHERE finder = ? AND subject = ?")
    .all(finder, subject) as {
    seq: number;
  }[];
  const ended = (seq: number): boolean => factTextChanged(store, ids, seq);
  return rows.some((r) => !ended(r.seq));
}

/** The highest `seq` that the last run of each finder saw. */
export type CleanupSeqs = Record<CleanupFinder, number>;

// A key that names no finder (a removed finder) is ignored; a finder with no key makes the value absent.
const cleanupSeqsSchema = z.record(z.string(), z.number().int().min(0)).transform((r, ctx): CleanupSeqs => {
  const seqs: Partial<CleanupSeqs> = {};
  for (const f of Object.values(CleanupFinder)) {
    const seq = r[f];
    if (seq === undefined) {
      ctx.addIssue({ code: "custom", message: `no seq for ${f}` });
      return z.NEVER;
    }
    seqs[f] = seq;
  }
  return seqs as CleanupSeqs;
});
// A stale name (a removed finder) is dropped from the list.
const cleanupFullSchema = z
  .array(z.string())
  .transform((names) => Object.values(CleanupFinder).filter((f) => names.includes(f)));

// Reads a meta value as parsed JSON; a missing row, bad JSON or a value the schema rejects is absent.
function readMetaJson<T>(store: Store, key: MetaKey, schema: z.ZodType<T>): T | undefined {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (row === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeMetaJson(store: Store, key: MetaKey, value: unknown): void {
  store.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

/**
 * Reads the highest `seq` that the last run of each finder saw.
 *
 * @param store - the open store
 * @returns the seq per finder; undefined when no worker has started on the store, or when the value does not parse
 * @sideEffects none (one read)
 */
export function readCleanupSeq(store: Store): CleanupSeqs | undefined {
  return readMetaJson(store, MetaKey.CleanupSeq, cleanupSeqsSchema);
}

/**
 * Writes the highest `seq` that the last run of each finder saw.
 *
 * @param store - the open store with the write connection
 * @param seqs - the seq per finder
 * @sideEffects one upsert on the `meta` table
 */
export function writeCleanupSeq(store: Store, seqs: CleanupSeqs): void {
  writeMetaJson(store, MetaKey.CleanupSeq, seqs);
}

/**
 * Reads the finders that the cap cut in their last run.
 *
 * @param store - the open store
 * @returns the finder names; empty when the key is absent or does not parse
 * @sideEffects none (one read)
 */
export function readCleanupFull(store: Store): CleanupFinder[] {
  return readMetaJson(store, MetaKey.CleanupFull, cleanupFullSchema) ?? [];
}

/**
 * Writes the finders that the cap cut in their last run.
 *
 * @param store - the open store with the write connection
 * @param finders - the finder names
 * @sideEffects one upsert on the `meta` table
 */
export function writeCleanupFull(store: Store, finders: CleanupFinder[]): void {
  writeMetaJson(store, MetaKey.CleanupFull, finders);
}

// A key that names no finder is ignored; a finder with no key, or a value outside the floor and the ceiling, is seeded or clamped.
const cleanupEverySchema = z.record(z.string(), z.number()).transform((r): CleanupEvery => {
  const every = { ...CLEANUP_EVERY };
  for (const f of CLEANUP_FINDERS) {
    const value = r[f];
    if (value !== undefined) every[f] = Math.min(CLEANUP_EVERY_MAX, Math.max(CLEANUP_EVERY_MIN, Math.round(value)));
  }
  return every;
});

/** The interval of each finder, in writes. */
export type CleanupEvery = Record<CleanupFinder, number>;

/**
 * Reads the interval of each finder from `meta.cleanup_every`.
 *
 * @param store - the open store
 * @returns the interval per finder in writes; a finder with no value, and every finder when the key is absent or does
 *   not parse, has its `CLEANUP_EVERY` seed
 * @sideEffects none (one read)
 */
export function readCleanupEvery(store: Store): CleanupEvery {
  return readMetaJson(store, MetaKey.CleanupEvery, cleanupEverySchema) ?? { ...CLEANUP_EVERY };
}

/**
 * Writes the interval of each finder.
 *
 * @param store - the open store with the write connection
 * @param every - the interval per finder, in writes
 * @sideEffects one upsert on the `meta` table
 */
export function writeCleanupEvery(store: Store, every: CleanupEvery): void {
  writeMetaJson(store, MetaKey.CleanupEvery, every);
}

/**
 * Reads the finders that ran and whose next interval is not yet set.
 *
 * @param store - the open store
 * @returns the finder names; empty when the key is absent or does not parse
 * @sideEffects none (one read)
 */
export function readCleanupPending(store: Store): CleanupFinder[] {
  return readMetaJson(store, MetaKey.CleanupPending, cleanupFullSchema) ?? [];
}

/**
 * Writes the finders that ran and whose next interval is not yet set.
 *
 * @param store - the open store with the write connection
 * @param finders - the finder names
 * @sideEffects one upsert on the `meta` table
 */
export function writeCleanupPending(store: Store, finders: CleanupFinder[]): void {
  writeMetaJson(store, MetaKey.CleanupPending, finders);
}

/**
 * Says whether a finder holds a `cleanupRepair` request that has not ended: one with the status `queued` or `running`.
 *
 * @param store - the open store
 * @param finder - the finder whose requests count
 * @returns true when such a request exists
 * @sideEffects none (one read)
 */
export function hasOpenRepairs(store: Store, finder: CleanupFinder): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 AS open FROM change_requests
       WHERE kind = ? AND status IN (?, ?) AND json_valid(change) AND json_extract(change, '$.finder') = ? LIMIT 1`,
    )
    .get(RequestKind.CleanupRepair, RequestStatus.Queued, RequestStatus.Running, finder);
  return row !== undefined;
}

/**
 * Counts the repairs of a finder after a position: the `cleanupRepair` requests of the finder that ended with an accepted change above `afterSeq`.
 *
 * @param store - the open store
 * @param finder - the finder whose requests count
 * @param afterSeq - the `seq` of the run of the finder; only changes above it count
 * @returns the number of such requests
 * @sideEffects none (one read)
 */
export function countRepairs(store: Store, finder: CleanupFinder, afterSeq: number): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(DISTINCT r.id) AS n
       FROM changes c JOIN change_requests r ON r.id = c.request_id
       WHERE r.kind = ? AND json_valid(r.change) AND json_extract(r.change, '$.finder') = ?
         AND c.outcome = ? AND c.seq > ?`,
    )
    .get(RequestKind.CleanupRepair, finder, ChangeOutcome.Accepted, afterSeq) as { n: number };
  return row.n;
}

/**
 * Reads the highest `seq` of the `changes` table.
 *
 * @param store - the open store
 * @returns the seq; 0 when no change exists
 * @sideEffects none (one read)
 */
export function highestChangeSeq(store: Store): number {
  const row = store.db.prepare("SELECT MAX(seq) AS seq FROM changes").get() as { seq: number | null };
  return row.seq ?? 0;
}

/**
 * Counts the writes above a position: the `changes` rows with the outcome `accepted` and a `seq` above `afterSeq`, of a request of the kind
 * `submission` or `operatorEdit` (design/cleanup.md, "Interval per check"). The children of a split submission are `submission` requests, so
 * they count. A write of a cleanup repair does not count, so the cleanup does not pull its own next run closer. A split, a duplicate and a rejection
 * are no write.
 *
 * @param store - the open store
 * @param afterSeq - the `seq` of the finder's last run; only changes above it count
 * @returns the number of such accepted changes above `afterSeq`
 * @sideEffects none (one read)
 */
export function countWritesSince(store: Store, afterSeq: number): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM changes c JOIN change_requests r ON r.id = c.request_id
       WHERE c.outcome = ? AND c.seq > ? AND r.kind IN (?, ?)`,
    )
    .get(ChangeOutcome.Accepted, afterSeq, RequestKind.Submission, RequestKind.OperatorEdit) as { n: number };
  return row.n;
}
