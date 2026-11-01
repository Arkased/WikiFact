import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStore, seedChange, type Store } from "../index.js";
import { observedFlags, toFactVersions, versionRowsOf } from "../console/versions.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => closeStore(store));

describe("observedFlags", () => {
  const v = (content: string, justification: string, is_deleted = 0) => ({ content, justification, is_deleted });

  it("marks the first version when its justification is not empty", () => {
    expect(observedFlags([v("a", "seen")])).toEqual([true]);
    expect(observedFlags([v("a", "")])).toEqual([false]);
    expect(observedFlags([v("a", "   ")])).toEqual([false]);
  });

  it("marks a content change or a deletion with a justification, not a derived version", () => {
    const rows = [v("a", "seen"), v("a", "derived"), v("b", ""), v("c", "seen again"), v("c", "gone", 1)];
    expect(observedFlags(rows)).toEqual([true, false, false, true, true]);
  });
});

describe("version rows", () => {
  it("load references, oldest first", async () => {
    const first = await seedChange(store, accepted([draft({ header: "Ref" })]), { now: T0 });
    const ref = first.factIds[0] ?? "";
    const second = await seedChange(store, accepted([draft({ header: "Main", references: [ref] })]), { now: T0 + 1 });
    const main = second.factIds[0] ?? "";
    await seedChange(store, accepted([draft({ factId: main, header: "Main", content: "Changed." })]), {
      now: T0 + 2,
    });

    const rows = versionRowsOf(store, main);
    expect(rows.map((r) => r.seq)).toEqual([second.seq, second.seq + 1]);
    const versions = toFactVersions(store, rows);
    expect(versions[0]?.references).toEqual([ref]);
    expect(versions[1]?.content).toBe("Changed.");
    expect(versionRowsOf(store, "nope")).toEqual([]);
  });
});
