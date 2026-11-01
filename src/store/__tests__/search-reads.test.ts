import { describe, expect, it } from "vitest";
import { RetrievalKind, SearchHitKind } from "../../domain/enums.js";
import { T0, draft, factIdOf, makeStore, write, accepted } from "../../../__tests__/helpers/store.js";
import { listSearchReads, recordRetrieval, recordSearch, type Store } from "../index.js";

function search(s: Store, id: string, at: number, factIds: string[]): void {
  recordSearch(s, {
    id,
    sessionId: null,
    query: `query ${id}`,
    at,
    durationMs: 1,
    results: factIds.map((targetId, i) => ({
      kind: SearchHitKind.Fact,
      targetId,
      rank: i + 1,
      ref: `${id}:${targetId}`,
    })),
  });
}

describe("listSearchReads", () => {
  it("gives each search its listed facts and the reads that link to it by ref, and leaves out a search with no result", () => {
    const s = makeStore();
    write(s, accepted([draft({ header: "Creeper damage", content: "Creepers do 10 damage." })]), T0);
    const factId = factIdOf(s);
    search(s, "a", T0 + 10, [factId]);
    search(s, "b", T0 + 20, [factId]);
    search(s, "none", T0 + 30, []);
    recordRetrieval(s, factId, { now: T0 + 11, ref: `a:${factId}` });
    recordRetrieval(s, factId, { now: T0 + 12, kind: RetrievalKind.Confirm, ref: `a:${factId}` });
    recordRetrieval(s, factId, { now: T0 + 13 });

    const [a, b, ...rest] = listSearchReads(s);

    expect(rest).toEqual([]);
    expect(a?.query).toBe("query a");
    expect(a?.results).toEqual([{ rank: 1, factId, header: "Creeper damage" }]);
    expect(a?.reads).toEqual([{ factId, header: "Creeper damage", content: "Creepers do 10 damage." }]);
    expect(b?.reads).toEqual([]);
  });

  it("lists the version that was the newest at the time of the search, and omits a fact with no version yet", () => {
    const s = makeStore();
    write(s, accepted([draft({ header: "Old header" })]), T0);
    const factId = factIdOf(s);
    search(s, "before", T0 + 10, [factId]);
    write(s, accepted([draft({ factId, header: "New header" })]), T0 + 100);
    search(s, "after", T0 + 200, [factId]);
    write(s, accepted([draft({ header: "Later fact" })]), T0 + 300);
    const laterId = (s.db.prepare("SELECT id FROM facts WHERE id != ?").get(factId) as { id: string }).id;
    search(s, "early", T0 + 20, [laterId]);

    const byId = new Map(listSearchReads(s).map((r) => [r.id, r]));

    expect(byId.get("before")?.results[0]?.header).toBe("Old header");
    expect(byId.get("after")?.results[0]?.header).toBe("New header");
    expect(byId.get("early")?.results).toEqual([]);
    expect(byId.get("early")?.omitted).toEqual([laterId]);
  });
});
