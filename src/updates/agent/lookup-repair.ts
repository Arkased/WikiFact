import { ChangeOutcome, LogEvent, LogLevel, ProcessOutcome, RequestKind, SearchHitKind } from "../../domain/enums.js";
import { applyChange, enqueueRequest, getSearchQuery, newId, search } from "../../store/index.js";
import type { ChangeSet, Request } from "../types.js";
import { logChange, questionContext } from "./context.js";
import { currentVersion, toDraft, unionNames } from "./draft-utils.js";
import { gather } from "./gather.js";
import { writeAndLint, type LintEnv } from "./lint.js";
import { mustFromModel } from "../../must.js";
import type { AgentContext, ProcessResult } from "./types.js";

/** The inputs of `priorQueryCheck`. */
export interface PriorQueryCheckOptions {
  req: Request;
  /** The fact that the prior query should find. Nothing is checked when it is absent. */
  relevantFactId: string | undefined;
  /** The kind of the request that is being processed. Only a submission enqueues a repair. */
  kind: RequestKind;
  /** Further fact ids that count as a hit, such as the equivalence fact that a repair wrote. */
  alsoAccept?: string[];
}

/**
 * Step 9. Checks that the prior query of the request now finds the fact. A submission that misses enqueues a
 * lookupRepair.
 *
 * @param ctx - the agent context
 * @param opts - the request, the fact that the query should find, the request kind and the other accepted ids
 * @returns the id of the lookupRepair request that it enqueued; undefined when the query finds the fact, there is
 *   no search or fact, the request is itself a repair, or the check failed
 * @sideEffects runs the embedder and reads the store for the search; may insert one queued lookupRepair row; logs
 *   one `LogEvent.PriorQuery` line (also for a failed check, whose error is swallowed, not thrown)
 */
export async function priorQueryCheck(ctx: AgentContext, opts: PriorQueryCheckOptions): Promise<string | undefined> {
  const { req, relevantFactId, kind, alsoAccept = [] } = opts;
  if (!req.searchId || !relevantFactId) return undefined;
  try {
    const priorQuery = getSearchQuery(ctx.store, req.searchId);
    if (priorQuery === undefined) return undefined;
    const results = await search(ctx.store, priorQuery);
    // After a repair the search returns the equivalence fact, not always the target.
    const hits = new Set([relevantFactId, ...alsoAccept]);
    if (results.some((r) => r.kind === SearchHitKind.Fact && hits.has(r.id))) return undefined;
    if (kind === RequestKind.Submission) {
      const id = enqueueRequest(ctx.store, {
        kind: RequestKind.LookupRepair,
        targets: [relevantFactId],
        searchId: req.searchId,
      });
      ctx.log({
        event: LogEvent.PriorQuery,
        level: LogLevel.Info,
        request_id: req.id,
        result: "miss",
        repairRequestId: id,
        factId: relevantFactId,
      });
      return id;
    }
    ctx.log({
      event: LogEvent.PriorQuery,
      level: LogLevel.Warn,
      request_id: req.id,
      result: "still misses after repair",
      factId: relevantFactId,
    });
  } catch (e) {
    // The change is committed. A failure here must not repeat the request.
    ctx.log({
      event: LogEvent.PriorQuery,
      level: LogLevel.Error,
      request_id: req.id,
      result: "check failed",
      error: String(e),
    });
  }
  return undefined;
}

/**
 * A lookupRepair request: step 1, Q10, steps 6, 8 and 9. Adds an equivalence fact so that the prior query finds the
 * target.
 *
 * @param ctx - the agent context
 * @param req - the lookupRepair request
 * @returns the accepted result with the seq of the repair change; `Skipped` (nothing written) when there is no search id (or no such search), the target is missing or deleted, or the search already returns the target
 * @throws {LintError} when the equivalence fact fails the lint twice
 * @throws {InvariantError} when Q10 returns no draft
 * @sideEffects reads the store; runs the embedder; one Q10 call; unless it skips, writes one change through
 *   `applyChange`; logs `LogEvent.LookupRepair` (on a skip), the change line and the prior query check line
 */
export async function lookupRepair(ctx: AgentContext, req: Request): Promise<ProcessResult> {
  const skipped = (reason: string): ProcessResult => {
    ctx.log({ event: LogEvent.LookupRepair, level: LogLevel.Info, request_id: req.id, skipped: reason });
    return { outcome: ProcessOutcome.Skipped, mergeSeqs: [], passes: 0, rejudged: 0 };
  };
  const g = await gather(ctx, req, false);
  const target = g.targetFacts[0];
  if (!req.searchId) return skipped("no searchId");
  const priorQuery = getSearchQuery(ctx.store, req.searchId);
  if (priorQuery === undefined) return skipped("search is gone");
  if (!target) return skipped("target does not exist");
  if (target.isDeleted) return skipped("target is deleted");

  const results = await search(ctx.store, priorQuery);
  if (results.some((r) => r.kind === SearchHitKind.Fact && r.id === target.factId)) {
    return skipped("search returns the fact now");
  }

  const qctx = questionContext(ctx);
  const qResults = results.flatMap((r) => (r.kind === SearchHitKind.Fact ? [{ id: r.id, header: r.header }] : []));
  const env: LintEnv = { drafted: new Set() };
  const unit = await writeAndLint(ctx, env, {
    write: (lintFailure) => ctx.q.q10({ priorQuery, target, results: qResults, lintFailure }, qctx),
    build: (res) => {
      const d = mustFromModel(res.drafts[0], "Q10 returned no draft");
      // The equivalence fact is derived: an empty justification, the target in references.
      return [{ ...toDraft(d, newId(), ""), references: unionNames(d.references ?? [], [target.factId]) }];
    },
  });
  const header = currentVersion(target).header;
  const cs: ChangeSet = {
    outcome: ChangeOutcome.Accepted,
    summary: `Lookup repair for "${priorQuery}": added "${mustFromModel(unit.drafts[0], "Q10 unit has no draft").header}" for "${header}".`,
    changeReasoning: `The search "${priorQuery}" did not return "${header}". The equivalence fact makes it return the fact.`,
    facts: unit.drafts,
  };
  const { seq, factIds } = await applyChange(ctx.store, req.id, cs);
  logChange(ctx, req, { seq, outcome: ChangeOutcome.Accepted, kind: "lookupRepair", passes: 0, rejudged: 0 });
  await priorQueryCheck(ctx, {
    req,
    relevantFactId: target.factId,
    kind: RequestKind.LookupRepair,
    alsoAccept: factIds,
  });
  return { outcome: ProcessOutcome.Accepted, seq, mergeSeqs: [], passes: 0, rejudged: 0 };
}
