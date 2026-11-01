import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deployPaths } from "../lib/deploy-paths.js";

describe("deployPaths", () => {
  it("puts the wikis, the logs and the start script under <home>/wikifact", () => {
    const root = join("home", "kevin", "wikifact");
    expect(deployPaths(join("home", "kevin"))).toEqual({
      root,
      wikis: join(root, "wikis"),
      logs: join(root, "wikis", ".logs"),
      startScript: join(root, "start-service.cmd"),
      taskScript: join(root, "start-service.ps1"),
    });
  });
});
