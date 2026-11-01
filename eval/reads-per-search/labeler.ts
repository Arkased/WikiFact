// The labeler of the test of the reads per search (docs/design/console.md, "The test of the reads per search"): one model
// question per search, on the call path of the judge of the benefit test.
import { z } from "zod";
import { costUsd, type PriceTable, type QuestionSettings } from "../../src/config/index.js";
import type { SearchRead } from "../../src/store/index.js";
import type { Transport } from "../../src/updates/index.js";
import { askJudgment } from "../lib/judgment.js";
import { ReadLabel } from "../lib/enums.js";

/** The label of a search, its reason, and the cost of the call. */
interface LabelResult {
  label: ReadLabel;
  /** One sentence. */
  reason: string;
  costUsd: number;
}

/** Marks a search as found, not found or misled. */
export interface Labeler {
  /**
   * Labels one search from its query, its listed results and its reads.
   *
   * @param search - the search with its listed facts and the facts that it read
   * @returns the label, the reason and the cost in USD
   * @throws {Error} when the model gives no valid label after one retry
   */
  label(search: SearchRead): Promise<LabelResult>;
}

const answerSchema = z.object({ label: z.nativeEnum(ReadLabel), reason: z.string() });

const SYSTEM = [
  "You label one search of a fact wiki that AI agents read. The agent searched with a query, got a list of facts (rank and header), and may have opened some of them (the full text is below).",
  "You do not see what the agent did next. Judge only whether the list answered the query, from the headers and from the full text of the facts that were opened.",
  'Answer with JSON: {"label": "found" | "not found" | "misled", "reason": "<one sentence>"}.',
  "found: a listed fact answers the query.",
  "not found: no listed fact answers the query.",
  "misled: the list looks like an answer to the query but is not, so that an agent that opens facts is led away from what it needs, or the opened facts show that the list did not answer the query.",
].join("\n");

/**
 * Renders a search as the user message of the labeler.
 *
 * @param s - the search
 * @returns the query, the listed facts and the full text of each fact that was read (once per fact)
 * @sideEffects none
 */
function render(s: SearchRead): string {
  const listed = s.results.map((r) => `${r.rank}. ${r.header}`).join("\n");
  const seen = new Set<string>();
  const opened = s.reads
    .filter((r) => !seen.has(r.factId) && seen.add(r.factId))
    .map((r) => `Header: ${r.header}\nContent: ${r.content}`)
    .join("\n\n");
  return [
    `Query: ${s.query}`,
    `Listed results:\n${listed === "" ? "(none)" : listed}`,
    `Facts that were opened:\n${opened === "" ? "(none)" : opened}`,
  ].join("\n\n");
}

/**
 * Builds the labeler on a transport of the question callers.
 *
 * @param transport - the transport that sends the request
 * @param settings - the model and the effort: a model of a higher tier, the `standard` preset of the judgment question
 * @param prices - the price table, for the cost of each call
 * @returns the labeler
 * @sideEffects each label sends one or two model requests through the transport
 */
export function modelLabeler(transport: Transport, settings: QuestionSettings, prices: PriceTable): Labeler {
  return {
    async label(search) {
      const { answer, usage } = await askJudgment(transport, settings, answerSchema, {
        system: SYSTEM,
        user: render(search),
      });
      return { label: answer.label, reason: answer.reason, costUsd: costUsd(prices, settings.model, usage) };
    },
  };
}
