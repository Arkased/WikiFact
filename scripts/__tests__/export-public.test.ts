import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateTermsFound, exportPublic } from "../lib/export-public.js";
import { ScriptError } from "../lib/shell.js";
import { PROCESS_START_TIMEOUT_MS } from "../../__tests__/helpers/timeouts.js";
import {
  BLOCK_TERM,
  STAMPS,
  TERMS_TEXT,
  commitAll,
  git,
  makeFixture,
  writeFiles,
  type Fixture,
} from "../../__tests__/helpers/export-fixture.js";

// Runs the export and returns the hits of the private terms that stopped it.
async function stoppedBy(fx: Fixture): Promise<{ where: string; term: string }[]> {
  const error = await exportPublic(fx.root, fx.target).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PrivateTermsFound);
  return (error as PrivateTermsFound).hits;
}

const tracked = (fx: Fixture): string[] => git(fx.target, ["ls-files"]).split("\n");

describe("exportPublic refusals", () => {
  it(
    "refuses a source with uncommitted changes, a branch other than build, and a dirty or foreign target",
    async () => {
      const fx = makeFixture();
      writeFiles(fx.root, { "src/code.ts": "changed\n" });
      await expect(exportPublic(fx.root, fx.target)).rejects.toThrow(/not clean/);
      commitAll(fx.root, "change");

      writeFiles(fx.target, { "stray.txt": "x" });
      await expect(exportPublic(fx.root, fx.target)).rejects.toThrow(/uncommitted/);
      git(fx.target, ["clean", "-fdq"]);

      await expect(exportPublic(fx.root, fx.root)).rejects.toThrow(/source/);
      await expect(exportPublic(fx.root, join(fx.target, ".git"))).rejects.toThrow();

      git(fx.root, ["checkout", "-q", "-b", "feature"]);
      await expect(exportPublic(fx.root, fx.target)).rejects.toThrow(/branch build/);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "refuses the source in another spelling of its case, a worktree of the source, and a folder in or around it",
    async () => {
      const fx = makeFixture();
      // Linux has 2 folders for 2 cases, so the upper-case path does not exist there.
      if (process.platform === "win32" || process.platform === "darwin") {
        await expect(exportPublic(fx.root, fx.root.toUpperCase())).rejects.toThrow(/source/);
      }

      const worktree = join(dirname(fx.root), "worktree");
      git(fx.root, ["worktree", "add", "-q", worktree, "-b", "other"]);
      await expect(exportPublic(fx.root, worktree)).rejects.toThrow(/shares its git folder/);

      const sub = join(fx.root, "sub");
      mkdirSync(sub);
      await expect(exportPublic(fx.root, sub)).rejects.toThrow(/one inside the other/);
      await expect(exportPublic(fx.root, dirname(fx.root))).rejects.toThrow(/one inside the other/);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "stops with a ScriptError that names a target that does not exist",
    async () => {
      const fx = makeFixture();
      const missing = join(fx.target, "no-such-folder");
      const error = await exportPublic(fx.root, missing).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScriptError);
      expect(String(error)).toContain(missing);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "takes a folder named ..x in the source as inside it",
    async () => {
      const fx = makeFixture();
      const inside = join(fx.root, "..x");
      mkdirSync(inside);
      await expect(exportPublic(fx.root, inside)).rejects.toThrow(/one inside the other/);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "stops with a ScriptError when the terms file is missing, and when it holds no term",
    async () => {
      const fx = makeFixture();
      rmSync(join(fx.root, "publication/private-terms.txt"));
      const error = await exportPublic(fx.root, fx.target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScriptError);
      expect(String(error)).toMatch(/is missing/);

      const empty = makeFixture("# only a comment\n");
      await expect(exportPublic(empty.root, empty.target)).rejects.toThrow(/holds no term/);
      writeFileSync(join(empty.root, "publication/private-terms.txt"), "");
      await expect(exportPublic(empty.root, empty.target)).rejects.toThrow(/holds no term/);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "stops when the public README is missing",
    async () => {
      const fx = makeFixture();
      git(fx.root, ["rm", "-q", "publication/README.md"]);
      commitAll(fx.root, "no readme");
      await expect(exportPublic(fx.root, fx.target)).rejects.toThrow(/README/);
    },
    PROCESS_START_TIMEOUT_MS,
  );
});

describe("exportPublic scan", () => {
  it(
    "scans the identity that the commit would take, in the environment of the commit",
    async () => {
      const fx = makeFixture();
      const before = process.env.GIT_COMMITTER_EMAIL;
      process.env.GIT_COMMITTER_EMAIL = "zorblax.industries@example.invalid";
      try {
        expect(await stoppedBy(fx)).toEqual([{ where: "git var GIT_COMMITTER_IDENT", term: BLOCK_TERM }]);
      } finally {
        if (before === undefined) delete process.env.GIT_COMMITTER_EMAIL;
        else process.env.GIT_COMMITTER_EMAIL = before;
      }
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "stops at a file that is not valid UTF-8 and is not on binaryAllow",
    async () => {
      const fx = makeFixture();
      writeFiles(fx.root, { "assets/other.dat": "" });
      writeFileSync(join(fx.root, "assets/other.dat"), Buffer.from([0xff, 0xfe, 0x00]));
      commitAll(fx.root, "binary");

      const error = await exportPublic(fx.root, fx.target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScriptError);
      expect(String(error)).toContain("assets/other.dat");
      expect(String(error)).not.toContain("assets/blob.bin");
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "scans an allowed binary file as latin1 and as UTF-16LE",
    async () => {
      const fx = makeFixture();
      const invalid = Buffer.from([0xff]);
      writeFiles(fx.root, { "assets/a.bin": "", "assets/b.bin": "", "assets/c.bin": "" });
      writeFileSync(join(fx.root, "assets/a.bin"), Buffer.concat([invalid, Buffer.from(BLOCK_TERM, "latin1")]));
      writeFileSync(join(fx.root, "assets/b.bin"), Buffer.concat([Buffer.from(BLOCK_TERM, "utf16le"), invalid]));
      writeFileSync(join(fx.root, "assets/c.bin"), Buffer.concat([invalid, Buffer.from(BLOCK_TERM, "utf16le")]));
      commitAll(fx.root, "binaries");

      const where = (await stoppedBy(fx)).map((h) => h.where);
      expect(where).toContain("assets/a.bin (as latin1)");
      expect(where).toContain("assets/b.bin (as utf16le)");
      expect(where).toContain("assets/c.bin (as utf16le, odd offset)");
      expect(where.filter((w) => w.startsWith("assets/blob.bin"))).toEqual([]);
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "treats a UTF-16LE file of ASCII text, which is valid UTF-8, as binary",
    async () => {
      const fx = makeFixture();
      const wide = Buffer.from(`note ${BLOCK_TERM} end`, "utf16le");
      writeFiles(fx.root, { "assets/wide.dat": "" });
      writeFileSync(join(fx.root, "assets/wide.dat"), wide);
      commitAll(fx.root, "wide");

      // Not allowed: the export stops on the file.
      const error = await exportPublic(fx.root, fx.target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ScriptError);
      expect(String(error)).toContain("assets/wide.dat");

      // Allowed: the scan finds the term in the UTF-16LE decoding.
      git(fx.root, ["rm", "-q", "assets/wide.dat"]);
      writeFiles(fx.root, { "assets/wide.bin": "" });
      writeFileSync(join(fx.root, "assets/wide.bin"), wide);
      commitAll(fx.root, "allow");
      const where = (await stoppedBy(fx)).map((h) => h.where);
      expect(where).toContain("assets/wide.bin (as utf16le)");
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "scans the path of each exported file",
    async () => {
      const fx = makeFixture();
      writeFiles(fx.root, { "docs/zorblax-industries-notes.md": "clean text\n" });
      commitAll(fx.root, "named");

      expect(await stoppedBy(fx)).toEqual([{ where: "docs/zorblax-industries-notes.md (path)", term: BLOCK_TERM }]);
    },
    PROCESS_START_TIMEOUT_MS,
  );
});

describe("exportPublic write", () => {
  it(
    "leaves the target as it was when the tree cannot be written",
    async () => {
      const fx = makeFixture();
      writeFiles(fx.target, { "keep.txt": "kept\n" });
      commitAll(fx.target, "keep");
      // A file named `demo` is in the way of the folder `demo/wikifact` of the demo copy.
      writeFiles(fx.root, { demo: "a file where the demo folder goes\n" });
      commitAll(fx.root, "clash");

      await expect(exportPublic(fx.root, fx.target)).rejects.toThrow();

      expect(readFileSync(join(fx.target, "keep.txt"), "utf8")).toBe("kept\n");
      expect(git(fx.target, ["status", "--porcelain"])).toBe("");
    },
    PROCESS_START_TIMEOUT_MS,
  );

  it(
    "reads the names of result files in the texts as they are written, after the pairs",
    async () => {
      const fx = makeFixture(`${TERMS_TEXT}ALIASRUN => ${STAMPS[1]}.json\n`);
      writeFiles(fx.root, { "docs/alias.md": "See ALIASRUN here.\n" });
      commitAll(fx.root, "alias");

      await exportPublic(fx.root, fx.target);

      expect(tracked(fx)).toContain(`eval/results/${STAMPS[1]}.json`);
      expect(readFileSync(join(fx.target, "docs/alias.md"), "utf8")).toBe(`See ${STAMPS[1]}.json here.\n`);
    },
    PROCESS_START_TIMEOUT_MS,
  );
});
