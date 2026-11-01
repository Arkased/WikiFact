import { LogEvent, LogLevel, SearchHitKind } from "../../domain/enums.js";
import { cosineDistance, embed } from "../../embed/index.js";
import { getFactMaterial, search, versionText, type Store } from "../../store/index.js";
import type { FactMaterial, Gathered, Request } from "../types.js";
import { must } from "../../must.js";
import type { AgentContext } from "./types.js";

/**
 * Step 1. Reads the targets of the request and, on request, the facts that look like the change.
 *
 * @param ctx - the agent context
 * @param req - the request
 * @param withCandidates - whether to search for candidate facts (a submission does, a lookupRepair does not)
 * @returns the subject, the target facts and the candidates by distance, nearest first (cosine
 *   distance of the nearest version); `candidates` is empty without `withCandidates`
 * @throws {InvariantError} when an embedding it needs is missing
 * @sideEffects reads the store; runs the embedder when searching; logs one `LogEvent.Gather` line for each target
 *   that is not a fact
 */
export async function gather(ctx: AgentContext, req: Request, withCandidates: boolean): Promise<Gathered> {
  const { store } = ctx;
  const targetFacts: FactMaterial[] = [];
  for (const id of req.targets) {
    const fact = getFactMaterial(store, id);
    if (fact) {
      targetFacts.push(fact);
      continue;
    }
    ctx.log({ event: LogEvent.Gather, level: LogLevel.Info, request_id: req.id, droppedTarget: id });
  }

  const candidates = withCandidates ? await findCandidates(ctx, req) : [];
  return { subject: ctx.config.subject, targetFacts, candidates };
}

// Searches the change text, then ranks the hit facts by the cosine distance of their nearest version.
function findCandidates(ctx: AgentContext, req: Request): Promise<Gathered["candidates"]> {
  return candidatesFor(ctx.store, req.change);
}

/**
 * The gather search on a text: the agent search with history, then the facts ranked by the cosine distance of their
 * nearest version to the text.
 *
 * @param store - the open store
 * @param text - the claim text, or the text of a draft
 * @returns the hit facts with their history, nearest first
 * @throws {InvariantError} when an embedding it needs is missing
 * @sideEffects reads the store; runs the embedder
 */
async function candidatesFor(store: Store, text: string): Promise<Gathered["candidates"]> {
  const hits = await search(store, text, { includeHistory: true });
  const ids: string[] = [];
  for (const h of hits) if (h.kind === SearchHitKind.Fact && !ids.includes(h.factId)) ids.push(h.factId);
  // A hit whose fact is gone from the store is dropped.
  const materials = ids.flatMap((id) => getFactMaterial(store, id) ?? []);
  const texts: string[] = [text];
  for (const m of materials) for (const v of m.versions) texts.push(versionText(v.header, v.content));
  const vecs = texts.length > 1 ? await embed(texts) : [];
  const queryVec = vecs[0];
  let k = 1;
  const scored = materials.map((fact) => {
    const distances = fact.versions.map(() => {
      const vec = must(vecs[k++], `no embedding for a version of fact ${fact.factId}`);
      return cosineDistance(must(queryVec, "no embedding for the change text"), vec);
    });
    return { fact, distance: Math.min(Infinity, ...distances) };
  });
  scored.sort((a, b) => a.distance - b.distance || (a.fact.factId < b.fact.factId ? -1 : 1));
  return scored;
}
