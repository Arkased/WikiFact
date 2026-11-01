import { describe, expect, it } from "vitest";
import {
  LogEvent,
  OperatorEditKind,
  ProcessOutcome,
  RejectReason,
  RequestKind,
  RequestStatus,
  RunOnceStatus,
} from "../../domain/enums.js";
import { checkIndex, enqueueOperatorEdit, getRequest, type OperatorEdit } from "../../store/index.js";
import { changesOf, count, world } from "../../../__tests__/helpers/updates.js";
import type { RunOnceResult } from "../index.js";

function must<T>(x: T | undefined | null): T {
  if (x === undefined || x === null) throw new Error("expected a value");
  return x;
}

function done(r: RunOnceResult) {
  if (r.status !== RunOnceStatus.Done) throw new Error(`expected done, got ${JSON.stringify(r)}`);
  return r.result;
}

// Enqueues an edit and runs the worker step that takes it.
async function runEdit(w: ReturnType<typeof world>, edit: OperatorEdit) {
  const id = enqueueOperatorEdit(w.store, edit);
  const r = await w.run();
  return { id, res: done(r) };
}

describe("an operatorEdit row", () => {
  it("is stored with a null justification and no targets, and parsed back by getRequest", () => {
    const w = world();
    const id = enqueueOperatorEdit(w.store, { edit: OperatorEditKind.Cleanup, note: "run it" });
    const row = must(getRequest(w.store, id));
    expect(row.kind).toBe(RequestKind.OperatorEdit);
    expect(row.justification).toBeNull();
    expect(row.targets).toEqual([]);
    expect(row.operatorEdit).toEqual({ edit: OperatorEditKind.Cleanup, note: "run it" });
  });

  it("refuses a note that is empty or longer than 500 characters", () => {
    const w = world();
    const base = { edit: OperatorEditKind.Reindex } as const;
    expect(() => enqueueOperatorEdit(w.store, { ...base, note: "  " })).toThrow();
    expect(() => enqueueOperatorEdit(w.store, { ...base, note: "x".repeat(501) })).toThrow();
    expect(() => enqueueOperatorEdit(w.store, { ...base, note: "x".repeat(500) })).not.toThrow();
  });

  it("makes no model call", async () => {
    const w = world();
    await runEdit(w, { edit: OperatorEditKind.Reindex, note: "n" });
    expect(w.q.calls).toHaveLength(0);
  });

  it("rejects a document that fails validation, without a retry", async () => {
    const w = world();
    const id = w.enqueue("x", "x");
    w.store.db
      .prepare("UPDATE change_requests SET kind = ?, change = ?, justification = NULL WHERE id = ?")
      .run(RequestKind.OperatorEdit, JSON.stringify({ edit: "unknown", note: "n" }), id);
    const res = done(await w.run());
    expect(res.outcome).toBe(ProcessOutcome.Rejected);
    expect(must(getRequest(w.store, id))).toMatchObject({ status: RequestStatus.Done, attempts: 0 });
    expect(must(changesOf(w.store, id)[0]).reject_reason).toBe(RejectReason.Unsupported);
  });
});

describe("a reindex", () => {
  it("rebuilds the index, writes no changes row and logs one line", async () => {
    const w = world();
    await w.seed({ header: "A", content: "A." });
    w.store.db.exec("DELETE FROM fact_versions_vec");
    expect(checkIndex(w.store).map((d) => d.table)).toContain("fact_versions_vec");
    const changesBefore = count(w.store, "changes");
    const { id, res } = await runEdit(w, { edit: OperatorEditKind.Reindex, note: "repair" });
    expect(res.outcome).toBe(ProcessOutcome.Skipped);
    expect(checkIndex(w.store)).toEqual([]);
    expect(count(w.store, "changes")).toBe(changesBefore);
    expect(must(getRequest(w.store, id)).status).toBe(RequestStatus.Done);
    expect(w.logs.filter((l) => l.event === LogEvent.OperatorReindex)).toHaveLength(1);
  });
});
