// technical/updates.md, "High volume mode", "Run": the group call of a round, its rate limit, its failed write and its tokens.
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../config/index.js";
import {
  BatchRunStatus,
  BatchStopReason,
  LogEvent,
  LogLevel,
  ProcessOutcome,
  RequestStatus,
} from "../../../domain/enums.js";
import type { LogLine } from "../../../log/index.js";
import { enqueueRequest, getRequest, type Store } from "../../../store/index.js";
import { StubQuestions } from "../../../../fakes/stub-questions.js";
import { makeFileStore } from "../../../../__tests__/helpers/store.js";
import type { GroupOutput, TokenUsage } from "../../types.js";
import { withFailedUsage } from "../../types.js";
import { runBatch } from "../index.js";
import { splitUsage } from "../round.js";

const settings = parseConfig({ embeddingModel: "test-model" }).highVolume;
/** A cut over which all requests group. */
const ONE_GROUP = 2;

/** A stub whose usage account the group call fills and the change lines drain, as the real questions do. */
class AccountQuestions extends StubQuestions {
  private pool: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  addUsage(u: TokenUsage): void {
    this.pool = {
      input: this.pool.input + u.input,
      output: this.pool.output + u.output,
      cacheRead: (this.pool.cacheRead ?? 0) + (u.cacheRead ?? 0),
      cacheWrite: (this.pool.cacheWrite ?? 0) + (u.cacheWrite ?? 0),
    };
  }

  takeUsage(): TokenUsage {
    const u = this.pool;
    this.pool = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    return u;
  }
}

function setup(): {
  store: Store;
  ids: string[];
  logs: LogLine[];
  run: (q: StubQuestions) => ReturnType<typeof runBatch>;
} {
  const store = makeFileStore();
  const ids = ["Zombies burn in sunlight daily", "Skeletons shoot arrows at players"].map((change, i) =>
    enqueueRequest(store, { change, justification: "I saw it." }, 1_000 + i),
  );
  const logs: LogLine[] = [];
  return {
    store,
    ids,
    logs,
    run: (q) =>
      runBatch({
        store,
        questions: q,
        config: { subject: "Minecraft" },
        settings: { ...settings, groupCut: ONE_GROUP },
        log: (l) => logs.push(l),
        probe: () => undefined,
        ids,
      }),
  };
}

const answerOf = (position: number): GroupOutput["answers"][number] => ({
  position,
  verdict: { supported: true, wrongRelated: [], reason: "" },
  draft: { header: `Fact ${position}`, content: `Content of fact ${position}`, references: [] },
});

describe("the group call of a round", () => {
  it("drops the batch on a rate limit of the group call and puts the requests back in the queue", async () => {
    const { store, ids, run } = setup();
    const q = new StubQuestions();
    q.group = { retries: 0, ask: () => Promise.reject(new Error("429 rate limit: try again later")) };
    const res = await run(q);
    expect(res).toMatchObject({ status: BatchRunStatus.RateLimited, requestId: ids[0] });
    for (const id of ids) expect(getRequest(store, id)?.status).toBe(RequestStatus.Queued);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM changes").get()).toEqual({ n: 0 });
    // No fall back to the pipeline of 1 request at a time: the model is limited.
    expect(q.count("q5")).toBe(0);
  });

  it("falls back from the failed claim on after a failed write, and keeps the earlier write of the group staged", async () => {
    const { store, ids, logs, run } = setup();
    const q = new StubQuestions();
    // The answer for claim 2 is missing, so its write fails; the write of claim 1 has gone through.
    q.group = {
      retries: 0,
      ask: () => Promise.resolve({ output: { answers: [answerOf(1)] }, usage: { input: 0, output: 0 } }),
    };
    const res = await run(q);
    expect(res).toMatchObject({ status: BatchRunStatus.Done, size: 2, outcomes: { [ProcessOutcome.Accepted]: 2 } });
    // Claim 1 came from the group answer, with no question of the pipeline; claim 2 ran the pipeline alone.
    expect(q.count("q5")).toBe(1);
    expect(logs.filter((l) => l.event === LogEvent.Unhandled && l.level === LogLevel.Warn)).toMatchObject([
      { error: expect.stringContaining("group write") as string },
    ]);
    for (const id of ids) expect(getRequest(store, id)?.status).toBe(RequestStatus.Done);
    const headers = (store.db.prepare("SELECT header FROM fact_versions").all() as { header: string }[]).map(
      (r) => r.header,
    );
    expect(headers).toContain("Fact 1");
    expect(headers).toHaveLength(2);
  });

  it("splits the tokens of the group call over the requests of the group, in the change lines", async () => {
    const { logs, run } = setup();
    const q = new AccountQuestions();
    q.group = {
      retries: 0,
      ask: () =>
        Promise.resolve({
          output: { answers: [answerOf(1), answerOf(2)] },
          usage: { input: 11, output: 5, cacheRead: 0, cacheWrite: 0 },
        }),
    };
    await run(q);
    const tokens = logs.filter((l) => l.event === LogEvent.Change).map((l) => l.tokens as TokenUsage);
    expect(tokens).toHaveLength(2);
    expect(tokens.reduce((n, t) => n + t.input, 0)).toBe(11);
    expect(tokens.reduce((n, t) => n + t.output, 0)).toBe(5);
  });

  it("gives the tokens of a failed group call to the change lines of the requests that fall back", async () => {
    const { logs, run } = setup();
    const q = new AccountQuestions();
    q.group = {
      retries: 0,
      ask: () => Promise.reject(withFailedUsage(new Error("invalid output after one retry"), { input: 11, output: 5 })),
    };
    const res = await run(q);
    expect(res).toMatchObject({ status: BatchRunStatus.Done, size: 2 });
    const tokens = logs.filter((l) => l.event === LogEvent.Change).map((l) => l.tokens as TokenUsage);
    expect(tokens).toHaveLength(2);
    expect(tokens.reduce((n, t) => n + t.input, 0)).toBe(11);
    expect(tokens.reduce((n, t) => n + t.output, 0)).toBe(5);
  });

  it("keeps all the shares of a failed group call in the usage account when a stop comes after the first fall back", async () => {
    const { store, ids } = setup();
    const added: TokenUsage[] = [];
    class Recording extends StubQuestions {
      addUsage(u: TokenUsage): void {
        added.push(u);
      }
    }
    const q = new Recording();
    q.group = {
      retries: 0,
      ask: () => Promise.reject(withFailedUsage(new Error("invalid output after one retry"), { input: 11, output: 5 })),
    };
    // The stop comes once the first request has run its pipeline.
    const res = await runBatch({
      store,
      questions: q,
      config: { subject: "Minecraft" },
      settings: { ...settings, groupCut: ONE_GROUP },
      log: () => undefined,
      probe: () => (q.count("q5") > 0 ? BatchStopReason.Signal : undefined),
      ids,
    });
    expect(res.status).toBe(BatchRunStatus.Stopped);
    expect(q.count("q5")).toBe(1);
    expect(added.reduce((n, u) => n + u.input, 0)).toBe(11);
    expect(added.reduce((n, u) => n + u.output, 0)).toBe(5);
  });
});

describe("splitUsage", () => {
  it("gives equal shares and the rest to the first, and the shares add up", () => {
    const shares = splitUsage({ input: 11, output: 5, cacheRead: 2, cacheWrite: 0 }, 3);
    expect(shares.map((s) => s.input)).toEqual([5, 3, 3]);
    expect(shares.reduce((n, s) => n + s.output, 0)).toBe(5);
    expect(shares.reduce((n, s) => n + (s.cacheRead ?? 0), 0)).toBe(2);
  });
});
