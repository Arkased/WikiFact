import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { relativeToRoot } from "../relative-path.js";

describe("relativeToRoot", () => {
  const root = join(process.cwd(), "some", "root");

  it("gives a path under the root relative, with forward slashes", () => {
    expect(relativeToRoot(join(root, "eval", "results", "a.json"), root)).toBe("eval/results/a.json");
  });

  it("resolves a relative path against the working directory", () => {
    expect(relativeToRoot(join("some", "root", "x.json"), root)).toBe("x.json");
  });

  it("defaults to the project root", () => {
    expect(relativeToRoot(join(process.cwd(), "package.json"))).toBe("package.json");
  });
});
