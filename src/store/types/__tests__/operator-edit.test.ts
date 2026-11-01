import { describe, expect, it } from "vitest";
import { OperatorEditKind } from "../../../domain/enums.js";
import { parseOperatorEdit } from "../operator-edit.js";

const doc = (o: object): string => JSON.stringify({ edit: OperatorEditKind.Cleanup, ...o });

describe("a cleanup operator edit", () => {
  it("parses with a note", () => {
    expect(parseOperatorEdit(doc({ note: "n" }))).toEqual({ edit: "cleanup", note: "n" });
  });

  it("rejects a missing or empty note, an unknown field and an unknown kind", () => {
    expect(() => parseOperatorEdit(doc({}))).toThrow("note");
    expect(() => parseOperatorEdit(doc({ note: " " }))).toThrow("note");
    expect(() => parseOperatorEdit(doc({ note: "n", extra: 1 }))).toThrow("invalid");
    expect(() => parseOperatorEdit(JSON.stringify({ edit: "unknown", note: "n" }))).toThrow("invalid");
  });
});
