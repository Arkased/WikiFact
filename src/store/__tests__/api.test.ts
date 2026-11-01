import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestKind, RequestStatus } from "../../domain/enums.js";
import {
  StoreMismatchError,
  closeStore,
  getRequest,
  isLiveFact,
  openStoreFor,
  seedChange,
  versionText,
  type Store,
} from "../index.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("expected a value");
  return x;
}

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

describe("isLiveFact", () => {
  it("is true for a live fact, false for a deleted one and for an unknown id", async () => {
    const { factIds } = await seedChange(store, accepted([draft()]));
    const id = factIds[0];
    expect(isLiveFact(store, id)).toBe(true);
    expect(isLiveFact(store, "01NOSUCHFACT")).toBe(false);
    await seedChange(
      store,
      accepted([{ factId: id, header: "", content: "", justification: "gone", references: [], isDeleted: true }]),
    );
    expect(isLiveFact(store, id)).toBe(false);
  });
});

describe("seedChange", () => {
  it("writes the change under a submission request that is already done", async () => {
    const res = await seedChange(store, accepted([draft()]), { now: T0 });
    expect(res.factIds).toHaveLength(1);
    expect(res.seq).toBeGreaterThan(0);
    const row = must(getRequest(store, res.requestId));
    expect(row.kind).toBe(RequestKind.Submission);
    expect(row.status).toBe(RequestStatus.Done);
    expect(row.finishedAt).toBe(T0);
    const change = store.db.prepare("SELECT request_id FROM changes WHERE seq = ?").get(res.seq) as {
      request_id: string;
    };
    expect(change.request_id).toBe(res.requestId);
  });

  it("takes the text of the request from the options", async () => {
    const res = await seedChange(store, accepted([draft()]), { change: "c1", justification: "j1" });
    const row = must(getRequest(store, res.requestId));
    expect(row.change).toBe("c1");
    expect(row.justification).toBe("j1");
  });

  it("leaves the queue empty for the worker", async () => {
    await seedChange(store, accepted([draft()]));
    const queued = store.db
      .prepare("SELECT count(*) AS n FROM change_requests WHERE status = ?")
      .get(RequestStatus.Queued);
    expect(queued).toEqual({ n: 0 });
  });
});

describe("openStoreFor", () => {
  const config = { embeddingModel: "test-model", weights: { wRead: 2 }, searchCap: 7, agentSearchCap: 9 };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-for-"));
  });

  it("opens a store with the model, weights and caps of the config", () => {
    const s = openStoreFor(config, join(dir, "a.sqlite"));
    try {
      expect(s.config).toMatchObject({ embeddingModel: "test-model", searchCap: 7, agentSearchCap: 9 });
      expect(s.weights.wRead).toBe(2);
    } finally {
      closeStore(s);
    }
  });

  it("opens a read connection on an existing file, and refuses another embedding model", () => {
    const path = join(dir, "b.sqlite");
    closeStore(openStoreFor(config, path));
    const r = openStoreFor(config, path, { readonly: true });
    try {
      expect(() => r.db.prepare("INSERT INTO meta(key, value) VALUES ('x', 'y')").run()).toThrow();
    } finally {
      closeStore(r);
    }
    expect(() => openStoreFor({ ...config, embeddingModel: "other" }, path)).toThrow(StoreMismatchError);
  });
});

describe("the barrel", () => {
  it("exports versionText as header, a full stop and the content", () => {
    expect(versionText("H", "C")).toBe("H. C");
  });
});
