import { describe, expect, it } from "vitest";
import { ReadsTargetKind } from "../../lib/enums.js";
import { READS_USAGE, parseReadsArgs } from "../args.js";

describe("parseReadsArgs", () => {
  it("gives the usage error without --db", () => {
    expect(parseReadsArgs([])).toEqual({ ok: false, error: READS_USAGE });
  });

  it("gives an error for --resume together with --out", () => {
    const r = parseReadsArgs(["--db", "a.sqlite", "--out", "o.json", "--resume", "r.json"]);
    expect(r.ok).toBe(false);
  });

  it("gives the new-file target for --out alone", () => {
    expect(parseReadsArgs(["--db", "a.sqlite", "--out", "o.json"])).toEqual({
      ok: true,
      db: "a.sqlite",
      target: { kind: ReadsTargetKind.New, path: "o.json" },
    });
  });

  it("gives the resume target for --resume alone", () => {
    expect(parseReadsArgs(["--db", "a.sqlite", "--resume", "r.json"])).toEqual({
      ok: true,
      db: "a.sqlite",
      target: { kind: ReadsTargetKind.Resume, path: "r.json" },
    });
  });
});
