import { LogEvent, LogLevel } from "../../domain/enums.js";
import type { FactMaterial, Gathered, Request } from "../types.js";
import { questionContext } from "./context.js";
import { currentVersion } from "./draft-utils.js";
import type { AgentContext } from "./types.js";

/**
 * Step 2. Asks Q1 which of the target and candidate facts the change is about.
 *
 * @param ctx - the agent context
 * @param req - the request
 * @param g - the gathered material
 * @returns the matching facts without duplicates, in the order Q1 named them
 * @sideEffects one Q1 call when there is a fact to match; logs a line for each id that Q1 invented
 */
export async function scopeMatch(ctx: AgentContext, req: Request, g: Gathered): Promise<FactMaterial[]> {
  const list: FactMaterial[] = [];
  const seen = new Set<string>();
  for (const f of [...g.targetFacts, ...g.candidates.map((c) => c.fact)]) {
    if (seen.has(f.factId)) continue;
    seen.add(f.factId);
    list.push(f);
  }
  if (list.length === 0) return [];
  const out = await ctx.q.q1(
    { change: req.change, candidates: list.map((f) => ({ factId: f.factId, header: currentVersion(f).header })) },
    questionContext(ctx),
  );
  const matches: FactMaterial[] = [];
  for (const id of out.matches) {
    const m = list.find((f) => f.factId === id);
    if (!m) {
      ctx.log({ event: LogEvent.Scope, level: LogLevel.Info, request_id: req.id, droppedMatch: id });
      continue;
    }
    if (!matches.includes(m)) matches.push(m);
  }
  return matches;
}
