import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageVersion, projectRoot } from "../paths.js";

describe("packageVersion", () => {
  it("is the version of package.json under the project root", () => {
    const raw: unknown = JSON.parse(readFileSync(join(projectRoot(), "package.json"), "utf8"));
    expect(raw).toMatchObject({ version: packageVersion() });
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
