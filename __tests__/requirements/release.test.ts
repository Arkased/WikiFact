// The requirement tests of the release (docs/requirements/release.md). One `it` for each row of the requirements
// table, named as its Name cell. The ship command runs against a fake for each step.
import { describe, expect, it } from "vitest";
import { requireReleaseTag } from "../../scripts/deploy.js";
import { ReleaseKind } from "../../eval/lib/enums.js";
import { ScriptError } from "../../scripts/lib/shell.js";
import type { Proof } from "../../scripts/lib/ship.js";
import { ship } from "../../scripts/lib/ship.js";
import { fakeIo, goodProof } from "../../scripts/__tests__/helpers/ship-io.js";

describe("Release requirements", () => {
  it("One-command ship", async () => {
    const calls: string[] = [];
    await ship(ReleaseKind.Patch, fakeIo(calls));
    expect(calls).toEqual(["clean", "check", "release", "backups", "deploy", "proof", "entry 0.1.19"]);
  });

  it("Ship guards", async () => {
    const dirtyCalls: string[] = [];
    const dirty = fakeIo(dirtyCalls, {
      requireCleanTree: () => {
        throw new ScriptError("the working tree is not clean");
      },
    });
    await expect(ship(ReleaseKind.Patch, dirty)).rejects.toThrow(/not clean/);
    expect(dirtyCalls).toEqual([]);

    const branchCalls: string[] = [];
    await expect(ship(ReleaseKind.Patch, fakeIo(branchCalls, { branch: () => "main" }))).rejects.toThrow(/build/);
    expect(branchCalls).toEqual(["clean"]);
  });

  it("Stop on failure", async () => {
    const checkCalls: string[] = [];
    const failedCheck = fakeIo(checkCalls, {
      check: () => {
        throw new ScriptError("npm run check failed");
      },
    });
    await expect(ship(ReleaseKind.Minor, failedCheck)).rejects.toThrow(/check/);
    expect(checkCalls).not.toContain("release");

    const deployCalls: string[] = [];
    const failedDeploy = fakeIo(deployCalls, { deploy: () => Promise.reject(new ScriptError("port is still in use")) });
    await expect(ship(ReleaseKind.Patch, failedDeploy)).rejects.toThrow(/still in use/);
    expect(deployCalls.some((c) => c.startsWith("entry"))).toBe(false);
  });

  it("Honest log", async () => {
    const calls: string[] = [];
    const entries: string[] = [];
    const bad: Proof = { ...goodProof(), consoleHasVersion: false };
    const io = fakeIo(calls, { commitEntry: (_version, entry) => void entries.push(entry) }, bad);
    await expect(ship(ReleaseKind.Patch, io)).rejects.toThrow(/proof/);
    // The entry is written before the ship fails, and it differs from the entry of a passed proof.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("FAILED");
    expect(await ship(ReleaseKind.Patch, fakeIo([]))).not.toContain("FAILED");
  });

  it("Release tag only", () => {
    expect(requireReleaseTag(() => "v0.1.19")).toBe("v0.1.19");
    expect(() => requireReleaseTag(() => null)).toThrow(/not a release tag/);
  });
});
