import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvVar, McpToolName, RequestKind, SearchHitKind } from "../../src/domain/enums.js";
import { closeStore } from "../../src/store/index.js";
import { decide, REASON, wikiToolCalls } from "../../eval/corrections/stop-hook.mjs";
import { z } from "zod";
import type { Consumer } from "../../eval/corrections/consumers/types.js";
import { namesFact } from "../../eval/corrections/count.js";
import { isWrong, loadData, type RequestRow } from "../../eval/corrections/data.js";
import { serverSpawnCommand } from "../../eval/corrections/paths.js";
import { formatTable } from "../../eval/corrections/report.js";
import { runCorrections } from "../../eval/corrections/run.js";
import { seedWiki } from "../../eval/corrections/seed.js";
import { FAKE_EMBEDDER_FLOOR } from "../../eval/lib/fake-embedder-floor.js";
import { acceptAllQuestions, stubConsumer } from "../../fakes/stub-consumer.js";
import { NameMatch, WorkerMode } from "../../eval/lib/enums.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

/**
 * The tasks that the runs of the stub consumer use: the first 8 touch 4 wrong facts, which is all the counts need.
 * The 20 tasks of the data only multiply the time of the run.
 */
const TASK_LIMIT = 8;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-corr-test-"));
});
describe("seed", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("has tasks that each touch a wrong fact, every wrong fact has a task and terms", () => {
    const d = loadData();
    const wrong = new Set(d.facts.filter(isWrong).map((f) => f.key));
    expect(wrong.size).toBeGreaterThan(0);
    for (const t of d.tasks) expect(wrong.has(t.wrong)).toBe(true);
    for (const k of wrong) expect(d.tasks.some((t) => t.wrong === k)).toBe(true);
    expect(Object.keys(d.terms).sort()).toEqual([...wrong].sort());
  });

  it("writes the facts, the read history and the cap", async () => {
    const s = await seedWiki(join(dir, "g.sqlite"), { cap: 5 });
    const n = (sql: string) => (s.store.db.prepare(sql).get() as { n: number }).n;
    const data = loadData();
    const total = data.facts.length + data.newFacts.length;
    expect(n("SELECT COUNT(*) AS n FROM current_fact_versions")).toBe(total);
    expect(n("SELECT COUNT(*) AS n FROM retrievals")).toBeGreaterThan(0);
    expect(s.config.searchCap).toBe(5);
    expect(s.ids.size).toBe(total);
    // The new facts have no history.
    const ids = loadData().newFacts.map((f) => {
      const id = s.ids.get(f.key);
      if (id === undefined) throw new Error(`no id for ${f.key}`);
      return id;
    });
    const reads = s.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM retrievals r JOIN fact_versions v ON v.id = r.fact_version_id WHERE v.fact_id IN (${ids.map(() => "?").join(",")})`,
      )
      .get(...ids) as { n: number };
    expect(reads.n).toBe(0);
    closeStore(s.store);
  });
});

describe("naming", () => {
  const d = loadData();
  const found = d.facts.find((x) => x.key === "creeper-fuse");
  if (!found) throw new Error("creeper-fuse is missing from the seed");
  const f = found;
  const row = (over: Partial<RequestRow>): RequestRow => ({
    id: "r",
    kind: RequestKind.Submission,
    change: "x",
    targets: "[]",
    justification: "y",
    received_at: 0,
    ...over,
  });
  it("names by target, header or terms, and not by an unrelated text", () => {
    expect(namesFact(row({ targets: '["ID"]' }), f, "ID", d.terms)).toBe(NameMatch.Target);
    expect(namesFact(row({ change: "Creeper fuse is 3 seconds" }), f, "ID", d.terms)).toBe(NameMatch.Header);
    expect(namesFact(row({ change: "A creeper explodes after 3 seconds" }), f, "ID", d.terms)).toBe(NameMatch.Terms);
    expect(namesFact(row({ change: "A zombie does 5 damage" }), f, "ID", d.terms)).toBeNull();
  });
});

describe("run with the stub consumer", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  it("counts reads, requestChange calls, naming, acceptance and F17 from the database", async () => {
    const r = await runCorrections({
      cap: 10,
      hook: false,
      relevanceFloor: FAKE_EMBEDDER_FLOOR,
      consumer: stubConsumer({ diligence: 1, reads: 10 }),
      consumerName: "stub",
      workerMode: WorkerMode.Stub,
      questions: acceptAllQuestions(),
      dir,
      limit: TASK_LIMIT,
    });
    const c = r.counts;
    expect(c.tasks).toBe(TASK_LIMIT);
    // At most 10 getFact calls per task, one retrievals row each.
    expect(c.retrievals).toBeGreaterThan(0);
    expect(c.retrievals).toBeLessThanOrEqual(c.tasks * 10);
    expect(c.readsOfWrong).toBeGreaterThan(0);
    // The seed requests are not counted.
    expect(c.requestChange).toBe(r.results.reduce((n, t) => n + t.submissions.length, 0));
    expect(c.requestChange).toBeGreaterThan(0);
    // The stub submits a correction only when it read the wrong fact, and the correction names it.
    expect(c.namingOwn).toBe(c.requestChange);
    expect(c.namingWrong).toBe(c.requestChange);
    expect(c.tasksWithCorrection).toBe(c.requestChange);
    expect(c.wrongFactsNamed).toBeGreaterThan(0);
    // The stub worker accepts every submission.
    expect(c.accepted).toBe(c.requestChange);
    expect(c.wrongFactsWithNewVersion).toBe(c.wrongFactsNamed);
    expect(c.f17.probes).toBeGreaterThan(0);
    expect(formatTable([r])).toContain("10");
  });

  it("runs the tasks in parallel with the same counts as the sequential run", async () => {
    // The consumer is wrapped to record how many tasks are open at once: overlap is the proof of a parallel run.
    const peak = { seq: 0, par: 0 };
    const run = (concurrency: number, sub: keyof typeof peak) => {
      const inner = stubConsumer({ diligence: 0.8, reads: 5 });
      let active = 0;
      const consumer: Consumer = async (task, ctx) => {
        peak[sub] = Math.max(peak[sub], ++active);
        try {
          return await inner(task, ctx);
        } finally {
          active--;
        }
      };
      return runCorrections({
        cap: 10,
        hook: false,
        relevanceFloor: FAKE_EMBEDDER_FLOOR,
        consumer,
        consumerName: "stub",
        workerMode: WorkerMode.Stub,
        questions: acceptAllQuestions(),
        dir: join(dir, sub),
        concurrency,
        limit: TASK_LIMIT,
      });
    };
    const seq = await run(1, "seq");
    const par = await run(6, "par");
    expect(peak.seq).toBe(1);
    expect(peak.par).toBeGreaterThan(1);
    expect(peak.par).toBeLessThanOrEqual(6);
    const {
      retrievals,
      requestChange,
      namingWrong,
      namingOwn,
      tasksWithCorrection,
      wrongFactsNamed,
      accepted,
      wrongFactsWithNewVersion,
    } = seq.counts;
    expect(requestChange).toBeGreaterThan(0);
    expect({ ...par.counts, f17: undefined, costUsd: 0 }).toMatchObject({
      retrievals,
      requestChange,
      namingWrong,
      namingOwn,
      tasksWithCorrection,
      wrongFactsNamed,
      accepted,
      wrongFactsWithNewVersion,
    });
    // Rows count per task: each task owns the same number of requests as in the sequential run.
    expect(par.results.map((t) => t.submissions.length)).toEqual(seq.results.map((t) => t.submissions.length));
    expect(par.results.map((t) => t.taskId)).toEqual(seq.results.map((t) => t.taskId));
    expect(par.concurrency).toBe(6);
  });

  it("counts nothing from the worker when it did not run", async () => {
    const r = await runCorrections({
      cap: 5,
      hook: false,
      relevanceFloor: FAKE_EMBEDDER_FLOOR,
      consumer: stubConsumer({ diligence: 1 }),
      consumerName: "stub",
      workerMode: WorkerMode.None,
      dir,
      limit: 4,
    });
    expect(r.counts.tasks).toBe(4);
    expect(r.counts.accepted).toBe(0);
    expect(r.counts.wrongFactsWithNewVersion).toBe(0);
  });

  it("runs every task of the data when no limit is given", async () => {
    const seen: string[] = [];
    const idle: Consumer = (task) => {
      seen.push(task.id);
      return Promise.resolve({ answer: "" });
    };
    const r = await runCorrections({
      cap: 5,
      hook: false,
      relevanceFloor: FAKE_EMBEDDER_FLOOR,
      consumer: idle,
      consumerName: "idle",
      workerMode: WorkerMode.None,
      dir,
    });
    const all = loadData().tasks.map((t) => t.id);
    expect(seen.sort()).toEqual([...all].sort());
    expect(r.results.map((t) => t.taskId)).toEqual(all);
    expect(r.counts.tasks).toBe(all.length);
  });

  it("a consumer that reads and never corrects gives 0 requestChange rows", async () => {
    const lazy: Consumer = async (task, ctx) => {
      const { createServer } = await import("../../src/mcp/server.js");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = createServer({
        dbPath: ctx.seeded.dbPath,
        config: ctx.seeded.config,
        writeStore: ctx.seeded.store,
        log: () => undefined,
      });
      const client = new Client({ name: "lazy", version: "0" });
      await Promise.all([server.connect(b), client.connect(a)]);
      const s = await client.callTool({ name: McpToolName.Search, arguments: { query: task.question } });
      const hits = z.object({
        results: z.array(z.object({ kind: z.nativeEnum(SearchHitKind), id: z.string() })),
      });
      const first = hits.parse(s.structuredContent).results.find((x) => x.kind === SearchHitKind.Fact);
      if (!first) throw new Error("the search found no fact");
      await client.callTool({ name: McpToolName.GetFact, arguments: { id: first.id } });
      await client.close();
      return { answer: "" };
    };
    const r = await runCorrections({
      cap: 10,
      hook: false,
      relevanceFloor: FAKE_EMBEDDER_FLOOR,
      consumer: lazy,
      consumerName: "lazy",
      workerMode: WorkerMode.Stub,
      dir,
      limit: 5,
    });
    expect(r.counts.retrievals).toBe(5);
    expect(r.counts.requestChange).toBe(0);
    expect(r.counts.accepted).toBe(0);
  });
});

describe("stop hook", { timeout: PROCESS_START_TIMEOUT_MS }, () => {
  const line = (name: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
  it("reads tool names from the transcript", () => {
    expect(
      wikiToolCalls(
        [line("mcp__wikifact__getFact"), "not json", JSON.stringify({ type: "user", message: { content: "hi" } })].join(
          "\n",
        ),
      ),
    ).toEqual(["mcp__wikifact__getFact"]);
  });
  it("blocks after a getFact or search with no requestChange", () => {
    expect(decide({}, line("mcp__wikifact__getFact"))).toEqual({ decision: "block", reason: REASON });
    expect(decide({}, line("mcp__wikifact__search"))?.decision).toBe("block");
  });
  it("allows after a requestChange, with no wiki read, and when the hook already blocked", () => {
    expect(decide({}, [line("mcp__wikifact__getFact"), line("mcp__wikifact__requestChange")].join("\n"))).toBeNull();
    expect(decide({}, line("Bash"))).toBeNull();
    expect(decide({}, "")).toBeNull();
    expect(decide({ stop_hook_active: true }, line("mcp__wikifact__getFact"))).toBeNull();
  });
  it("runs as a command: stdin in, a block decision on stdout, a log line", () => {
    const tr = join(dir, "t.jsonl");
    const log = join(dir, "hook.log");
    writeFileSync(tr, line("mcp__wikifact__getFact") + "\n");
    const hook = join(process.cwd(), "eval", "corrections", "stop-hook.mjs");
    const run = (input: object) =>
      spawnSync("node", [hook], {
        input: JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, [EnvVar.WikifactHookLog]: log },
      });
    const blocked = run({ transcript_path: tr, stop_hook_active: false });
    expect(blocked.status).toBe(0);
    expect(JSON.parse(blocked.stdout)).toEqual({ decision: "block", reason: REASON });
    expect(run({ transcript_path: tr, stop_hook_active: true }).stdout).toBe("");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("server spawn command", () => {
  it("starts src/cli.ts through tsx and names no dist path", () => {
    const { command, args } = serverSpawnCommand("/tmp/x.sqlite");
    const all = [command, ...args].join(" ").replaceAll("\\", "/");
    expect(all).toContain("src/cli.ts");
    expect(all).toContain("tsx");
    // tsx itself lives at node_modules/tsx/dist; the project's own build output is dist/src.
    expect(all).not.toContain("dist/src");
    expect(args.slice(-3)).toEqual(["serve", "--db", "/tmp/x.sqlite"]);
  });
});
