// The stubs of the correction test (`eval/corrections.ts --stub`) and its tests: a scripted consumer, a worker
// that accepts every submission, and the seeded generator that the consumer uses.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpToolName, SearchHitKind } from "../src/domain/enums.js";
import { createServer } from "../src/mcp/server.js";
import type { Consumer } from "../eval/corrections/consumers/types.js";
import { StubQuestions } from "./stub-questions.js";

/** The multiplier of the linear congruential generator (Numerical Recipes). */
const LCG_MULTIPLIER = 1664525;
/** The increment of the linear congruential generator. */
const LCG_INCREMENT = 1013904223;
/** 2^32, the size of the generator state; it turns a state into a number in [0, 1). */
const LCG_MODULUS = 2 ** 32;

/** The base of the seed of a stub consumer; the task number is added to it. */
const CONSUMER_SEED_BASE = 42;
/** The share of corrections that name the wrong fact by id; the others name it in words only. */
const TARGET_SHARE = 0.5;
/** The default share of tasks in which the stub consumer corrects a wrong fact that it saw, without the hook. */
const DEFAULT_DILIGENCE = 0.5;
/** The default share with the hook on, as if the hook had pushed the consumer. */
const DEFAULT_HOOK_DILIGENCE = 0.9;
/** The default number of facts that the stub consumer reads per task. */
const DEFAULT_READS = 5;

/**
 * Builds a small deterministic random generator (a linear congruential generator), so that a stub run gives the
 * same numbers each time.
 *
 * @param seed - the start state; it is taken as an unsigned 32 bit integer
 * @returns a function that gives the next number in [0, 1) on each call
 * @sideEffects none; the returned function mutates the state of the generator
 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return s / LCG_MODULUS;
  };
}

/** The options of `stubConsumer`. */
export interface StubConsumerOptions {
  /** The chance of a correction after the consumer read a wrong fact, with the hook off. Default 0.5. */
  diligence?: number;
  /** The same chance with the hook on. Default 0.9. */
  hookDiligence?: number;
  /** How many facts of the search the consumer reads. Default 5. */
  reads?: number;
}

/** The part of a tool result that the stub consumer reads: the search hits and the id of a new request. */
const toolOutput = z.object({
  results: z.array(z.object({ kind: z.nativeEnum(SearchHitKind), id: z.string() })).optional(),
  requestId: z.string().optional(),
});

// Does nothing; the log of the in-process server.
const noLog = (): void => undefined;

/**
 * Builds the scripted consumer. It calls the real tools through the real server over InMemoryTransport.
 * It knows the ground truth: it reads the top fact results, and when a wrong fact is among them it submits
 * a correction with the probability `diligence`. This proves the harness. It measures nothing about a model.
 *
 * @param opts - the diligence (0..1) with and without the hook and the number of facts to read
 * @returns a consumer for `runCorrections`; its promise rejects when the task names a fact that is not in the data
 * @sideEffects the consumer opens an MCP client and server per task and closes them after, calls the tools (they
 *   write retrieval rows and queue rows to the seeded store)
 */
export function stubConsumer(opts: StubConsumerOptions = {}): Consumer {
  return async (task, ctx) => {
    const { seeded, data } = ctx;
    // One generator per task, so the answer does not depend on the order in which tasks run.
    const rand = seededRandom(CONSUMER_SEED_BASE + Number(task.id.replace(/\D/g, "")));
    const requestIds: string[] = [];
    const p = ctx.hook ? (opts.hookDiligence ?? DEFAULT_HOOK_DILIGENCE) : (opts.diligence ?? DEFAULT_DILIGENCE);
    const reads = opts.reads ?? DEFAULT_READS;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      dbPath: seeded.dbPath,
      config: seeded.config,
      writeStore: seeded.store,
      log: noLog,
    });
    const client = new Client({ name: "stub-consumer", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    let calls = 0;
    const call = async (name: string, args: Record<string, unknown>): Promise<z.infer<typeof toolOutput>> => {
      calls++;
      const res = await client.callTool({ name, arguments: args });
      const parsed = toolOutput.safeParse(res.structuredContent);
      return parsed.success ? parsed.data : {};
    };
    try {
      const own = data.facts.find((x) => x.key === task.wrong);
      if (!own) throw new Error(`stub consumer: task ${task.id} names the unknown fact ${task.wrong}`);
      const s = await call(McpToolName.Search, { query: task.question });
      const facts = (s.results ?? []).filter((r) => r.kind === SearchHitKind.Fact).slice(0, reads);
      let sawWrong = false;
      for (const f of facts) {
        await call(McpToolName.GetFact, { id: f.id });
        if (seeded.keyOf.get(f.id) === task.wrong) sawWrong = true;
      }
      if (sawWrong && rand() < p) {
        const ownId = seeded.ids.get(own.key);
        const withTarget = rand() < TARGET_SHARE;
        const r = await call(McpToolName.RequestChange, {
          change: `${own.header}: ${own.reality}`,
          justification: task.observation,
          ...(withTarget && ownId ? { targets: [ownId] } : {}),
        });
        if (r.requestId) requestIds.push(r.requestId);
      }
      return {
        answer: sawWrong ? `(stub) ${own.reality}` : "(stub) no answer",
        toolCalls: calls,
        requestIds,
      };
    } finally {
      await client.close();
      await server.close();
    }
  };
}

/**
 * Builds the questions of a worker that accepts every submission. Q1 matches a candidate whose header the change names,
 * and the other questions keep the stub defaults, so Q4 accepts. The numbers it gives are not real acceptances.
 *
 * @returns a `StubQuestions` for `drainQueue`
 * @sideEffects none
 */
export function acceptAllQuestions(): StubQuestions {
  return new StubQuestions({
    q1: (i) => {
      const text = i.change.toLowerCase();
      const hit = i.candidates.find((c) => text.includes(c.header.toLowerCase()));
      return { matches: hit ? [hit.factId] : [] };
    },
  });
}
