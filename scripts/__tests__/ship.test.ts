import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReleaseKind } from "../../eval/lib/enums.js";
import { cutRelease, parseReleaseKind } from "../lib/release.js";
import { ScriptError } from "../lib/shell.js";
import {
  CONSOLE_ATTEMPTS,
  backupOlderWikis,
  commitSubjects,
  findListeningLine,
  formatEntry,
  insertEntry,
  proofPassed,
  runProof,
  ship,
} from "../lib/ship.js";
import type { BackupDeps, DeployEntry } from "../lib/ship.js";
import { CODE_SCHEMA, fakeIo, goodProof } from "./helpers/ship-io.js";

describe("ship", () => {
  it("keeps the lines of the deploy in the entry", async () => {
    const entry = await ship(ReleaseKind.Patch, fakeIo([]));
    expect(entry).toContain("started the scheduled task WikiFact");
  });
});

describe("parseReleaseKind", () => {
  it("accepts the three kinds and refuses others", () => {
    expect(parseReleaseKind("minor")).toBe(ReleaseKind.Minor);
    expect(() => parseReleaseKind(undefined)).toThrow(ScriptError);
    expect(() => parseReleaseKind("huge")).toThrow(ScriptError);
  });
});

describe("cutRelease", () => {
  it("bumps first, then moves main to build and returns to build, and returns the tag", () => {
    const seen: string[] = [];
    const tag = cutRelease(
      ReleaseKind.Patch,
      (file, args) => void seen.push(`${file} ${args.join(" ")}`),
      () => "v0.1.19\n",
    );
    expect(tag).toBe("v0.1.19");
    expect(seen[0]).toContain("version patch");
    expect(seen.at(-1)).toContain("checkout build");
    expect(seen.some((c) => c.includes("merge") && c.includes("--ff-only"))).toBe(true);
  });

  it("refuses an empty capture of the tag", () => {
    expect(() =>
      cutRelease(
        ReleaseKind.Patch,
        () => undefined,
        () => "",
      ),
    ).toThrow(ScriptError);
  });
});

describe("commitSubjects", () => {
  it("lists the subjects between the previous tag and the new tag", () => {
    const subjects = commitSubjects("v0.1.19", (args) => {
      if (args[0] === "describe") return { code: 0, stdout: "v0.1.18\n" };
      return args.includes("v0.1.18..v0.1.19") ? { code: 0, stdout: "Second\nFirst\n" } : { code: 1, stdout: "" };
    });
    expect(subjects).toEqual(["Second", "First"]);
  });

  it("lists nothing when there is no previous tag", () => {
    expect(commitSubjects("v0.1.1", () => ({ code: 128, stdout: "" }))).toEqual([]);
  });

  it("lists nothing, and does not ask for the log, when git describe succeeds but prints no tag", () => {
    const asked: string[] = [];
    const subjects = commitSubjects("v0.1.1", (args) => {
      asked.push(args[0] ?? "");
      return { code: 0, stdout: "\n" };
    });
    expect(subjects).toEqual([]);
    expect(asked).not.toContain("log");
  });
});

describe("backupOlderWikis", () => {
  function deps(stored: Record<string, number | null>, copied: string[]): BackupDeps {
    return {
      list: () => Object.keys(stored),
      stored: (wiki) => stored[wiki] ?? null,
      copy: (wiki, to) => {
        copied.push(`${wiki}->${to}`);
        return Promise.resolve();
      },
    };
  }

  it("writes an entry that names the backup relative to the wikis folder, with no path of the home", async () => {
    const home = join(tmpdir(), "injected-home");
    const wikis = join(home, "wikis");
    const copiedTo: string[] = [];
    const made = await backupOlderWikis(
      {
        list: () => ["wikifact"],
        stored: () => CODE_SCHEMA - 1,
        copy: (_wiki, to) => {
          copiedTo.push(join(wikis, to));
          return Promise.resolve();
        },
      },
      CODE_SCHEMA,
      "0.1.19",
    );
    const text = formatEntry({
      version: "0.1.19",
      time: new Date("2026-10-14T03:07:42.000Z"),
      changes: [],
      lines: [],
      proof: goodProof(),
      backups: made,
    });
    expect(copiedTo[0]).toContain(home);
    expect(text).toContain(".backups/wikifact-0.1.19.sqlite");
    expect(text).not.toContain(home);
  });

  it("copies nothing when the schema equals the code", async () => {
    const copied: string[] = [];
    const made = await backupOlderWikis(deps({ wikifact: CODE_SCHEMA }, copied), CODE_SCHEMA, "0.1.19");
    expect(copied).toEqual([]);
    expect(made).toEqual([]);
  });

  it("copies only the older wikis among several, and skips a wiki with no stored schema", async () => {
    const copied: string[] = [];
    const made = await backupOlderWikis(
      deps({ old: 3, current: CODE_SCHEMA, empty: null }, copied),
      CODE_SCHEMA,
      "0.1.19",
    );
    expect(made.map((b) => b.wiki)).toEqual(["old"]);
  });
});

describe("findListeningLine", () => {
  const before = '{"event":"listening","ts":"2026-10-14T02:00:00.000Z"}';
  const after = '{"event":"listening","ts":"2026-10-14T03:00:05.000Z"}';

  it("returns the first listening line at or after the start of the deploy", () => {
    const text = ["not json", before, '{"event":"wiki_mounted","ts":"2026-10-14T03:00:06.000Z"}', after].join("\n");
    expect(findListeningLine(text, new Date("2026-10-14T03:00:00.000Z"))).toBe(after);
  });

  it("returns null when only older lines exist", () => {
    expect(findListeningLine(before, new Date("2026-10-14T03:00:00.000Z"))).toBeNull();
  });
});

describe("runProof", () => {
  const since = new Date("2026-10-14T03:00:00.000Z");
  const schemas = [{ wiki: "wikifact", stored: CODE_SCHEMA, code: CODE_SCHEMA }];

  it("passes when the port answers, the console names the version and the schemas match", async () => {
    const proof = await runProof(
      {
        portAnswers: () => Promise.resolve(true),
        consolePage: () => Promise.resolve("<title>WikiFact v0.1.19</title>"),
        schemas: () => schemas,
        serviceLog: () => '{"event":"listening","ts":"2026-10-14T03:00:05.000Z"}',
        wait: () => Promise.resolve(),
      },
      "0.1.19",
      since,
    );
    expect(proofPassed(proof)).toBe(true);
    expect(proof.listening).not.toBeNull();
  });

  it("does not take a longer version for a shorter one: v0.1.19 is not v0.1.1", async () => {
    const proof = await runProof(
      {
        portAnswers: () => Promise.resolve(true),
        consolePage: () => Promise.resolve("<title>WikiFact v0.1.19</title>"),
        schemas: () => schemas,
        serviceLog: () => null,
        wait: () => Promise.resolve(),
      },
      "0.1.1",
      since,
    );
    expect(proof.consoleHasVersion).toBe(false);
  });

  it("reads the console again until it names the new version: the first read can reach the old process", async () => {
    const pages = ["<title>WikiFact v0.1.18</title>", null, "<title>WikiFact v0.1.19</title>"];
    let reads = 0;
    const proof = await runProof(
      {
        portAnswers: () => Promise.resolve(true),
        consolePage: () => Promise.resolve(pages[reads++] ?? null),
        schemas: () => schemas,
        serviceLog: () => null,
        wait: () => Promise.resolve(),
      },
      "0.1.19",
      since,
    );
    expect(proof.consoleHasVersion).toBe(true);
    expect(reads).toBe(pages.length);
  });

  it("fails after the retries when the console keeps naming the old version", async () => {
    const waits: number[] = [];
    let reads = 0;
    const proof = await runProof(
      {
        portAnswers: () => Promise.resolve(true),
        consolePage: () => {
          reads += 1;
          return Promise.resolve("<title>WikiFact v0.1.18</title>");
        },
        schemas: () => schemas,
        serviceLog: () => null,
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
      "0.1.19",
      since,
    );
    expect(proofPassed(proof)).toBe(false);
    expect(reads).toBe(CONSOLE_ATTEMPTS);
    expect(waits).toHaveLength(CONSOLE_ATTEMPTS - 1);
  });

  it("fails when a wiki is still on an older schema", () => {
    expect(
      proofPassed({ ...goodProof(), schemas: [{ wiki: "wikifact", stored: CODE_SCHEMA - 1, code: CODE_SCHEMA }] }),
    ).toBe(false);
  });

  it("fails without a console request when the port does not answer", async () => {
    let asked = false;
    const proof = await runProof(
      {
        portAnswers: () => Promise.resolve(false),
        consolePage: () => {
          asked = true;
          return Promise.resolve(null);
        },
        schemas: () => schemas,
        serviceLog: () => null,
        wait: () => Promise.resolve(),
      },
      "0.1.19",
      since,
    );
    expect(proofPassed(proof)).toBe(false);
    expect(asked).toBe(false);
  });
});

describe("deploy log entry", () => {
  function entry(over: Partial<DeployEntry> = {}): DeployEntry {
    return {
      version: "0.1.19",
      time: new Date("2026-10-14T03:07:42.000Z"),
      changes: ["Tag work"],
      lines: ["stopped the service on 127.0.0.1:7777 (pid 1 and its children)", "started the scheduled task WikiFact"],
      proof: goodProof(),
      backups: [{ wiki: "wikifact", schema: 5, path: ".backups/wikifact-0.1.19.sqlite" }],
      ...over,
    };
  }

  it("carries the version, the UTC time, the lines, the listening line, the proof and the backup path", () => {
    const text = formatEntry(entry());
    expect(text).toContain("## v0.1.19, 2026-10-14 03:07 UTC");
    expect(text).toContain("stopped the service");
    expect(text).toContain("started the scheduled task");
    expect(text).toContain('"event":"listening"');
    expect(text).toContain("wikifact-0.1.19.sqlite");
    expect(text).toContain("Tag work");
  });

  it("says that no backup was made when none was needed, and marks a failed proof", () => {
    const text = formatEntry(entry({ backups: [], proof: { ...goodProof(), portAnswers: false } }));
    expect(text).toMatch(/No backup/);
    expect(text).toContain("FAILED");
  });

  it("goes above the older entries and below the introduction", () => {
    const file = "# Deploy log\n\nIntro.\n\n## v0.1.18, 2026-10-14 02:40 UTC\n\nOld.\n";
    const out = insertEntry(file, formatEntry(entry()));
    expect(out.indexOf("Intro.")).toBeLessThan(out.indexOf("## v0.1.19"));
    expect(out.indexOf("## v0.1.19")).toBeLessThan(out.indexOf("## v0.1.18"));
  });
});
