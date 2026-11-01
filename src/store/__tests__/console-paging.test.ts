import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  InvalidPageError,
  MAX_LIMIT,
  compareKeys,
  decodeCursor,
  encodeCursor,
  pageLimit,
  pageOf,
  type SortKey,
} from "../console/paging.js";

describe("cursors", () => {
  it("round-trip a sort key and reject anything else", () => {
    for (const key of [
      { k: 3, id: "a" },
      { k: "zeta", id: "b" },
      { k: null, id: "c" },
      { k: 0.1 + 0.2, id: "d" },
    ]) {
      expect(decodeCursor(encodeCursor(key))).toEqual(key);
    }
    expect(() => decodeCursor("not base64 json")).toThrow(InvalidPageError);
    expect(() => decodeCursor(Buffer.from('{"k":1}').toString("base64url"))).toThrow(InvalidPageError);
  });
});

describe("pageLimit", () => {
  it("defaults to 50 and accepts 1 to 200 only", () => {
    expect(pageLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(pageLimit(1)).toBe(1);
    expect(pageLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    for (const bad of [0, 201, 1.5, -1, NaN]) expect(() => pageLimit(bad)).toThrow(InvalidPageError);
  });
});

describe("compareKeys", () => {
  const keys: SortKey[] = [
    { k: 1, id: "b" },
    { k: null, id: "a" },
    { k: 2, id: "a" },
    { k: 1, id: "a" },
  ];
  it("orders descending with null last and ties by id", () => {
    expect([...keys].sort(compareKeys(true)).map((x) => `${String(x.k)}/${x.id}`)).toEqual([
      "2/a",
      "1/a",
      "1/b",
      "null/a",
    ]);
  });
  it("orders ascending with null still last", () => {
    expect([...keys].sort(compareKeys(false)).map((x) => `${String(x.k)}/${x.id}`)).toEqual([
      "1/a",
      "1/b",
      "2/a",
      "null/a",
    ]);
  });
  it("orders strings", () => {
    const s: SortKey[] = [
      { k: "b", id: "1" },
      { k: "a", id: "2" },
    ];
    expect([...s].sort(compareKeys(false)).map((x) => x.k)).toEqual(["a", "b"]);
    expect([...s].sort(compareKeys(true)).map((x) => x.k)).toEqual(["b", "a"]);
  });
});

describe("pageOf", () => {
  const rows = [5, 3, 9, 1, 7].map((n) => ({ n, id: `id${n}` }));
  const keyOf = (r: { n: number; id: string }): SortKey => ({ k: r.n, id: r.id });

  it("walks a list across page boundaries and ends with a null cursor", () => {
    const p1 = pageOf(rows, keyOf, compareKeys(true), { limit: 2 });
    expect(p1.items.map((r) => r.n)).toEqual([9, 7]);
    expect(p1.next).not.toBeNull();
    const p2 = pageOf(rows, keyOf, compareKeys(true), { limit: 2, cursor: p1.next ?? undefined });
    expect(p2.items.map((r) => r.n)).toEqual([5, 3]);
    const p3 = pageOf(rows, keyOf, compareKeys(true), { limit: 2, cursor: p2.next ?? undefined });
    expect(p3.items.map((r) => r.n)).toEqual([1]);
    expect(p3.next).toBeNull();
  });

  it("has no next cursor when the page holds the whole list", () => {
    const p = pageOf(rows, keyOf, compareKeys(false), { limit: 5 });
    expect(p.items.map((r) => r.n)).toEqual([1, 3, 5, 7, 9]);
    expect(p.next).toBeNull();
    expect(pageOf([], keyOf, compareKeys(false), {})).toEqual({ items: [], next: null });
  });

  it("resumes after a row that was removed, from its key", () => {
    const cursor = encodeCursor({ k: 6, id: "id6" });
    const p = pageOf(rows, keyOf, compareKeys(true), { limit: 10, cursor });
    expect(p.items.map((r) => r.n)).toEqual([5, 3, 1]);
  });

  it("rejects a bad limit or cursor", () => {
    expect(() => pageOf(rows, keyOf, compareKeys(true), { limit: 0 })).toThrow(InvalidPageError);
    expect(() => pageOf(rows, keyOf, compareKeys(true), { cursor: "???" })).toThrow(InvalidPageError);
  });
});
