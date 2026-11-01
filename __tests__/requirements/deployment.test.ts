// The requirement tests of the deployment (docs/requirements/deployment.md). One `it` for each row of the
// requirements table, named as its Name cell.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pinoRoll from "pino-roll";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeployStep } from "../../eval/lib/enums.js";
import { deploySteps, isOurService, stopService } from "../../scripts/deploy.js";
import type { StopIo } from "../../scripts/deploy.js";
import { backupOlderWikis, proofPassed, runProof } from "../../scripts/lib/ship.js";
import { CODE_SCHEMA } from "../../scripts/__tests__/helpers/ship-io.js";
import { writesAllowed } from "../../src/console/auth.js";
import { searchPage } from "../../src/console/pages/search.js";
import { parse } from "../../src/console/__tests__/helpers/dom.js";
import { fakeWrites, post, serveConsole } from "../../src/console/__tests__/helpers/serve.js";
import { openTmpWiki } from "../../src/console/__tests__/helpers/tmp-wiki.js";
import { EXIT_REFUSED } from "../../src/cli/command.js";
import { Mode } from "../../src/domain/enums.js";
import { fileLoggerRolls, rollOptions } from "../../src/log/index.js";
import { serve } from "../../src/mcp/commands.js";
import { createServer } from "../../src/mcp/server.js";
import { fakeChild, type FakeChild } from "../../src/service/__tests__/helpers/fake-child.js";
import { runService } from "../../src/service/run.js";
import { RESTART_DELAY_MAX_MS, superviseWorker } from "../../src/service/worker-supervisor.js";
import { commands as updateCommands } from "../../src/updates/commands.js";
import { seedChange } from "../../src/store/index.js";
import { must } from "../helpers/must.js";
import { T0, accepted, draft } from "../helpers/store.js";

/** How many event-loop turns the test lets an MCP call run while the warm-up hook is pending. */
const EARLY_TURNS = 20;
/** The most directory reads the log-space test makes per round while it waits for the roll to delete old files. */
const MAX_POLLS = 50;
/** The roll size of the log-space test, in megabytes: about 1 KB. */
const TINY_ROLL_MB = 0.001;
/** The write rounds of the log-space test; each round writes about twice the roll size. */
const WRITE_ROUNDS = 6;
/** The lines per round of the log-space test. */
const LINES_PER_ROUND = 20;
/** The characters per line of the log-space test. */
const LINE_CHARS = 100;

/**
 * Lets the event loop run `n` turns, so that work already in flight can finish.
 *
 * @param n - the number of turns
 * @returns once the turns are done
 * @sideEffects none
 */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

const workerCommand = must(updateCommands.find((c) => c.name === "worker"));

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-deployment-"));
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("Deployment requirements", () => {
  it.todo("Starts at logon");

  it("One config entry", () => {
    // The one entry is held by the plugin `wikifact`; the part of WikiFact is that its deploy adds none.
    for (const task of [true, false]) {
      for (const step of deploySteps({ task })) expect(step).not.toMatch(/mcp/i);
    }
    for (const step of Object.values(DeployStep)) expect(step).not.toMatch(/mcp/i);
  });

  it("Local only", async () => {
    const db = join(dir, "g.sqlite");
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ mode: Mode.Local }));
    const out: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      out.push(String(s));
      return true;
    }) as never);
    const prev = process.exitCode;
    try {
      await serve({ db, rest: [], http: 3999, host: "0.0.0.0" });
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = prev;
    }
    expect(out.join("")).toContain("0.0.0.0");
    expect(existsSync(db)).toBe(false);

    // The service command refuses the same way, before it binds a port or opens a database.
    const wikis = join(dir, "wikis");
    mkdirSync(join(wikis, "alpha"), { recursive: true });
    writeFileSync(join(wikis, "alpha", "wikifact.json"), JSON.stringify({ mode: Mode.Local }));
    const serviceOut: string[] = [];
    const serviceSpy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      serviceOut.push(String(s));
      return true;
    }) as never);
    process.exitCode = undefined;
    try {
      await runService({ db, rest: [], wikis, http: 0, host: "0.0.0.0" });
      expect(process.exitCode).toBe(EXIT_REFUSED);
    } finally {
      serviceSpy.mockRestore();
      process.exitCode = prev;
    }
    expect(serviceOut.join("")).toContain("0.0.0.0");
    expect(serviceOut.join("")).toContain("alpha");
    expect(readdirSync(join(wikis, "alpha"))).toEqual(["wikifact.json"]);
  });

  it("Key for deployed", async () => {
    // The worker command of a deployed wiki without an API key exits with a message and does not start. The transport
    // rules themselves are the "Credentials" requirement of updates.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WIKIFACT_TRANSPORT;
    writeFileSync(join(dir, "wikifact.json"), JSON.stringify({ mode: Mode.Deployed }));
    const out: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      out.push(String(s));
      return true;
    }) as never);
    const prev = process.exitCode;
    try {
      await workerCommand.run({ db: join(dir, "k.sqlite"), rest: [] });
      expect(process.exitCode).toBe(EXIT_REFUSED);
    } finally {
      spy.mockRestore();
      process.exitCode = prev;
    }
    expect(out.join("")).toContain("ANTHROPIC_API_KEY");
  });

  it.todo("Known consumers");

  it("Edits refused when deployed", async () => {
    const fake = fakeWrites();
    const wiki = openTmpWiki("alpha", { mode: Mode.Deployed, writes: fake.writes });
    const server = await serveConsole(wiki.deps);
    try {
      const paths = [
        "/console/w/alpha/jobs/reindex",
        "/console/w/alpha/jobs/cleanup",
        "/console/wikis",
        "/console/w/alpha/settings/description",
      ];
      for (const p of paths) {
        const res = await post(server.base, p, { confirm: "1", note: "n", description: "d", name: "x", subject: "s" });
        expect(res.status, p).toBe(403);
      }
      expect(fake.calls).toEqual([]);
      expect(wiki.store.db.prepare("SELECT COUNT(*) AS n FROM change_requests").get()).toEqual({ n: 0 });
      // The pages offer no form to the operator either.
      const page = parse(await (await fetch(`${server.base}/console/w/alpha/requests`)).text());
      expect(page.forms().filter((f) => f.method === "post")).toEqual([]);
      expect(writesAllowed({ mode: Mode.Deployed, host: "127.0.0.1" })).toBe(false);
      expect(writesAllowed({ mode: Mode.Deployed, host: "0.0.0.0" })).toBe(false);
    } finally {
      await server.close();
      wiki.close();
    }
  });

  it("Safe upgrade", async () => {
    // The wiki whose stored schema is older than the code is copied; one that is current is not.
    const copied: string[] = [];
    const deps = (stored: Record<string, number>) => ({
      list: () => Object.keys(stored),
      stored: (wiki: string) => stored[wiki] ?? null,
      copy: (wiki: string, to: string) => {
        copied.push(`${wiki}->${to}`);
        return Promise.resolve();
      },
    });
    const made = await backupOlderWikis(deps({ old: CODE_SCHEMA - 1, current: CODE_SCHEMA }), CODE_SCHEMA, "0.1.19");
    expect(made.map((b) => b.wiki)).toEqual(["old"]);
    expect(copied).toHaveLength(1);

    // The deploy stops the old service before it installs.
    const steps = deploySteps({ task: true });
    expect(steps.indexOf(DeployStep.StopService)).toBeLessThan(steps.indexOf(DeployStep.Install));

    // The proof fails when the console names another version.
    const proof = await runProof(
      {
        portAnswers: () => Promise.resolve(true),
        consolePage: () => Promise.resolve("v0.1.18"),
        schemas: () => [{ wiki: "wikifact", stored: CODE_SCHEMA, code: CODE_SCHEMA }],
        serviceLog: () => null,
        wait: () => Promise.resolve(),
      },
      "0.1.19",
      new Date("2026-10-14T03:00:00.000Z"),
    );
    expect(proofPassed(proof)).toBe(false);
  });

  it("Safe stop", async () => {
    // A listener that is not a wikifact service stops the deploy, and nothing is killed.
    const killed: number[] = [];
    const io: StopIo = {
      listening: () => Promise.resolve([4242]),
      describe: () => Promise.resolve({ name: "node.exe", cmd: "python -m http.server 7777" }),
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
      waitFree: () => Promise.resolve(true),
      log: () => undefined,
    };
    await expect(stopService(io)).rejects.toThrow(/not a wikifact service/);
    expect(killed).toEqual([]);

    expect(isOurService({ name: "python.exe", cmd: "python -m http.server" })).toBe(false);
    expect(isOurService({ name: "node.exe", cmd: "" })).toBe(false);
  });

  it("Early accept", async () => {
    const wiki = openTmpWiki();
    try {
      const seeded = await seedChange(
        wiki.store,
        accepted([draft({ header: "Creeper damage", content: "Creepers do 12 damage." })]),
        { now: T0 },
      );
      let ready = false;
      const deps = {
        ...wiki.deps,
        ready: () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              ready = true;
              resolve();
            }, 0);
          }),
      };
      const page = parse(await searchPage({ ...wiki.ctx({}, "q=creepers+do+12+damage"), deps }));
      expect(ready).toBe(true);
      expect(page.links().map((l) => l.href)).toContain(`/console/w/alpha/facts/${seeded.factIds[0]}`);

      // An MCP search that arrives during the warm-up waits for it, and then answers.
      let release: () => void = () => undefined;
      const warm = new Promise<void>((resolve) => {
        release = resolve;
      });
      const server = createServer({
        dbPath: wiki.wiki.dbPath,
        config: wiki.wiki.config,
        writeStore: wiki.store,
        log: () => undefined,
        ready: () => warm,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "early-accept", version: "0" });
      await Promise.all([server.connect(a), client.connect(b)]);
      try {
        let answered = false;
        const call = client.callTool({ name: "search", arguments: { query: "creepers do 12 damage" } }).then((r) => {
          answered = true;
          return r;
        });
        // The connection is accepted and the call is in flight, but it does not answer while the hook is pending.
        await turns(EARLY_TURNS);
        expect(answered).toBe(false);
        release();
        const result = await call;
        expect(answered).toBe(true);
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result.structuredContent)).toContain("Creeper damage");
      } finally {
        release();
        await client.close();
      }
    } finally {
      wiki.close();
    }
  });

  it("Worker restart", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeChild[] = [];
      superviseWorker({
        wiki: "alpha",
        log: () => undefined,
        countRestart: () => children.length,
        start: () => {
          const child = fakeChild();
          children.push(child);
          return child.worker;
        },
      });
      children[0]?.runs();
      // The worker stops while the service runs; nobody acts.
      children[0]?.exit(1);
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MAX_MS);
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Log space", async () => {
    const rolls = fileLoggerRolls("/logs", "svc");
    for (const roll of [rolls.full, rolls.errors]) {
      expect(roll).toHaveProperty("size");
      expect(roll).not.toHaveProperty("frequency");
      expect(roll.limit?.count).toBeGreaterThan(0);
    }

    // The count of files stays at the limit after many more writes than one file holds. A small size and count go
    // through the same options builder that the logger uses.
    const logs = join(dir, "logs");
    const keep = 2;
    const stream = await pinoRoll(rollOptions(join(logs, "svc"), TINY_ROLL_MB, keep));
    const counts: number[] = [];
    const fileCount = (): number => readdirSync(logs).filter((f) => /^svc\.\d+\.log$/.test(f)).length;
    try {
      for (let round = 0; round < WRITE_ROUNDS; round++) {
        // pino-roll emits "cleanup-complete" once a roll has deleted the old files.
        const cleaned = new Promise<void>((resolve) => stream.once("cleanup-complete", resolve));
        for (let i = 0; i < LINES_PER_ROUND; i++) stream.write(`${"x".repeat(LINE_CHARS)}\n`);
        await cleaned;
        // Further rolls of the same round may still be in flight (the library has no event for "all rolls done"),
        // so poll the directory, one event-loop turn per read, until the count settles at the limit.
        for (let poll = 0; poll < MAX_POLLS && fileCount() > keep; poll++) await turns(1);
        counts.push(fileCount());
      }
    } finally {
      stream.end();
    }
    // The writes rolled more files than the limit, and the count of files on disk never passed `limit.count`.
    const numbers = readdirSync(logs).map((f) => Number(/^svc\.(\d+)\.log$/.exec(f)?.[1]));
    expect(Math.max(...numbers)).toBeGreaterThan(keep);
    expect(counts.at(-1)).toBe(keep);
    expect(Math.max(...counts)).toBe(keep);
  });

  it.todo("Any OS");
});
