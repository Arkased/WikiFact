import { describe, expect, it } from "vitest";
import { OperatorEditKind } from "../../../domain/enums.js";
import { editName } from "../operator-edit.js";

describe("editName", () => {
  it("names a cleanup run in words", () => {
    expect(editName(OperatorEditKind.Cleanup)).toBe("cleanup run");
  });
});
