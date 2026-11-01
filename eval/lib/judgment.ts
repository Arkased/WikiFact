// The shared call of the judgment questions of the evals: the judge of the benefit test (technical/evaluation.md, "The
// judge") and the labeler of the test of the reads per search both go through it.
import { z } from "zod";
import type { QuestionSettings } from "../../src/config/index.js";
import { MessageRole, QuestionKind, StopReason } from "../../src/domain/index.js";
import { errorMessage } from "../../src/must.js";
import { jsonSchemaOf, modelFeatures, type Transport } from "../../src/updates/index.js";

/** The time the judge has to answer, in ms. */
const JUDGE_TIMEOUT_MS = 180_000;
/** The token limit of a verdict. */
const JUDGE_MAX_TOKENS = 4096;
/** Attempts per verdict: the first, and one retry with the validation error. */
const JUDGE_ATTEMPTS = 2;

const stripFence = (t: string): string =>
  t
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

/** The tokens of the requests of one `askJudgment`, summed over the retry. */
export interface JudgmentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Asks the model one judgment question and parses the JSON answer with a schema; one retry shows the model its validation
 * error. The judge of the benefit test and the labeler of the test of the reads per search both go through it.
 *
 * @param transport - the transport that sends the request
 * @param settings - the model and the effort
 * @param schema - the zod schema of the answer
 * @param prompt - the texts of the request
 * @param prompt.system - the system text
 * @param prompt.user - the user text
 * @returns the parsed answer and the tokens of all requests made
 * @throws {Error} when the model refuses, gives no valid answer after one retry, or does not answer in time
 * @sideEffects one or two model requests through the transport
 */
export async function askJudgment<S extends z.ZodType>(
  transport: Transport,
  settings: QuestionSettings,
  schema: S,
  prompt: { system: string; user: string },
): Promise<{ answer: z.infer<S>; usage: JudgmentUsage }> {
  const features = modelFeatures(settings.model);
  const jsonSchema = jsonSchemaOf(schema);
  const messages: { role: MessageRole; content: string }[] = [{ role: MessageRole.User, content: prompt.user }];
  const usage: JudgmentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastError = "";
  for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
    try {
      const res = await transport.send(
        {
          model: settings.model,
          kind: QuestionKind.Judgment,
          effort: settings.effort,
          system: prompt.system,
          messages: [...messages],
          schema: jsonSchema,
          maxTokens: JUDGE_MAX_TOKENS,
          stream: false,
          thinking: features.thinking,
          fallback: features.fallback,
        },
        controller.signal,
      );
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      usage.cacheRead += res.usage.cacheRead;
      usage.cacheWrite += res.usage.cacheWrite;
      if (res.stopReason === StopReason.Refusal) throw new Error("the judge refused to answer");
      let json: unknown;
      try {
        json = JSON.parse(stripFence(res.text));
      } catch (e) {
        lastError = `the answer is not JSON (${errorMessage(e)})`;
        messages.push(
          { role: MessageRole.Assistant, content: res.text },
          { role: MessageRole.User, content: `Your answer is not valid: ${lastError}. Answer again.` },
        );
        continue;
      }
      const parsed = schema.safeParse(json);
      if (parsed.success) return { answer: parsed.data, usage };
      lastError = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      messages.push(
        { role: MessageRole.Assistant, content: res.text },
        { role: MessageRole.User, content: `Your answer is not valid: ${lastError}. Answer again.` },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`the judge gave no valid verdict: ${lastError}`);
}
