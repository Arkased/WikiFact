// The requirement tests of the publication (docs/requirements/publication.md). One `it` for each row of the
// requirements table, named as its Name cell. The export runs on a fixture: a small git repo with fake files and a small
// store made with the code of `src/store/`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeStore, countFacts, openStore, readQueuePause, search, type Store } from "../../src/store/index.js";
import {
  BLOCK_TERM,
  FAKE_HOME,
  FAKE_HOME_DASHED,
  FIXTURE_MODEL,
  REPLACEMENT,
  STAMPS,
  commitAll,
  git,
  makeFixture,
  writeFiles,
  type Fixture,
} from "../helpers/export-fixture.js";
import { PrivateTermsFound, exportPublic } from "../../scripts/lib/export-public.js";
import { decisionLinksOutsideLists, plainDecisionMentions } from "../../scripts/lib/export-links.js";
import { isExcluded, loadExportRules } from "../../scripts/lib/export-rules.js";
import { findTerms } from "../../scripts/lib/export-terms.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

const TIMEOUT = PROCESS_START_TIMEOUT_MS;

const REPO_ROOT = join(import.meta.dirname, "../..");
const repoText = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

// The body of the section with a title at a heading level, up to the next heading of the same or a higher level.
function sectionOf(text: string, level: number, title: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${"#".repeat(level)} ${title}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex((l) => new RegExp(`^#{1,${level}} `).test(l));
  return rest.slice(0, stop < 0 ? undefined : stop).join("\n");
}

// The tracked files of the target, after the export.
const tracked = (fx: Fixture): string[] => git(fx.target, ["ls-files"]).split("\n");
const read = (fx: Fixture, path: string): string => readFileSync(join(fx.target, path), "utf8");

// Opens the demo copy in the target without a write.
function openCopy(fx: Fixture): Store {
  return openStore(join(fx.target, "demo/wikifact/game.sqlite"), { embeddingModel: FIXTURE_MODEL }, { readonly: true });
}

// Runs the export and returns the hits of the private terms that stopped it.
async function stoppedBy(fx: Fixture): Promise<{ where: string; term: string }[]> {
  const error = await exportPublic(fx.root, fx.target).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PrivateTermsFound);
  return (error as PrivateTermsFound).hits;
}

describe("Publication requirements", () => {
  it(
    "Public export",
    async () => {
      const fx = makeFixture();
      const first = await exportPublic(fx.root, fx.target);

      expect(first).toEqual({ version: "1.2.3", committed: true });
      expect(git(fx.target, ["log", "-1", "--format=%s"])).toBe("WikiFact v1.2.3");
      expect(git(fx.target, ["rev-list", "--count", "HEAD"])).toBe("2");

      // The internal process is not in the output; the code and the product records are.
      const files = tracked(fx);
      for (const out of ["CLAUDE.md", ".claude/", ".github/ISSUE_TEMPLATE/", ".worktreeinclude", "reports/"]) {
        expect(files.filter((f) => f.startsWith(out))).toEqual([]);
      }
      // Of `publication/` only the rules file is copied, so a reader sees what was left out.
      expect(files.filter((f) => f.startsWith("publication/"))).toEqual(["publication/export.json"]);
      expect(read(fx, "publication/export.json")).toBe(readFileSync(join(fx.root, "publication/export.json"), "utf8"));
      expect(files.filter((f) => f.startsWith("docs/decisions/"))).toEqual([]);
      expect(files).toContain("src/code.ts");
      expect(read(fx, "README.md")).toContain("fake public README");
      expect(JSON.parse(read(fx, "package.json"))).not.toHaveProperty("private");

      // The newest result file and the newest summary file stay, a named one stays, the others go.
      expect(files).toEqual(
        expect.arrayContaining([
          `eval/results/${STAMPS[2]}.json`,
          `eval/results/summary-${STAMPS[2]}.json`,
          `eval/results/${STAMPS[0]}.json`,
        ]),
      );
      expect(files).not.toContain(`eval/results/${STAMPS[1]}.json`);
      expect(files).not.toContain(`eval/results/summary-${STAMPS[0]}.json`);

      // A link to an excluded path is plain text; a decision link of a reference list leaves no trace.
      const guide = read(fx, "docs/guide.md");
      expect(guide).toContain("See the rules and the deploys.");
      expect(guide).toContain("The cache is kept.");
      expect(guide).toContain("The cache is bounded (#60).");
      expect(guide).toContain("The queue is fair ([Tests](code-standard.md)).");
      // The text is built from parts, so that this file holds no plain mention of a record.
      expect(guide).toContain(`The ${["decision", "0002"].join(" ")} stands alone.`);
      expect(guide).not.toContain("decisions/");

      // A file deleted in the source disappears from the target.
      git(fx.root, ["rm", "-q", "src/code.ts"]);
      commitAll(fx.root, "delete code");
      expect((await exportPublic(fx.root, fx.target)).committed).toBe(true);
      expect(tracked(fx)).not.toContain("src/code.ts");
      expect(existsSync(join(fx.target, "src/code.ts"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "No private data",
    async () => {
      // A block term stops the export with its location, and the target gets no commit and no file.
      const leak = makeFixture();
      writeFiles(leak.root, { "docs/leak.md": `line 1\nthe ${BLOCK_TERM.replace(" ", "-")} office\n` });
      commitAll(leak.root, "leak");
      const head = git(leak.target, ["rev-parse", "HEAD"]);
      expect(await stoppedBy(leak)).toContainEqual({ where: "docs/leak.md:2", term: BLOCK_TERM });
      expect(git(leak.target, ["rev-parse", "HEAD"])).toBe(head);
      expect(tracked(leak)).toEqual([""]);
      expect(readdirSync(leak.target)).toEqual([".git"]);

      // The author of the commit is scanned too.
      git(leak.target, ["config", "user.email", "zorblax.industries@example.invalid"]);
      git(leak.root, ["rm", "-q", "docs/leak.md"]);
      commitAll(leak.root, "no leak");
      expect(await stoppedBy(leak)).toEqual([
        { where: "git var GIT_AUTHOR_IDENT", term: BLOCK_TERM },
        { where: "git var GIT_COMMITTER_IDENT", term: BLOCK_TERM },
      ]);

      // A block term in the demo copy stops the export with the table, the column and the row id.
      const inStore = makeFixture("creeper fuse lasts\n");
      const storeHits = await stoppedBy(inStore);
      expect(storeHits.map((h) => h.term)).toContain("creeper fuse lasts");
      expect(storeHits.some((h) => /^fact_versions\.content rowid \d+$/.test(h.where))).toBe(true);

      // A pair is replaced in the files and in the store, the full-text index included. The folder name that Claude
      // Code makes of the path matches the term of the path.
      const pair = makeFixture();
      writeFiles(pair.root, {
        "docs/trace.md": `a ${FAKE_HOME}\\proj\nb ${FAKE_HOME_DASHED}-proj\n`,
      });
      commitAll(pair.root, "trace");
      await exportPublic(pair.root, pair.target);
      expect(read(pair, "docs/trace.md")).toBe(`a ${REPLACEMENT}\\proj\nb ${REPLACEMENT.replaceAll("/", "-")}-proj\n`);

      const live = openStore(pair.dbPath, { embeddingModel: FIXTURE_MODEL }, { readonly: true });
      const ftsHits = (store: Store, word: string): number =>
        (
          store.db.prepare("SELECT count(*) AS n FROM fact_versions_fts WHERE fact_versions_fts MATCH ?").get(word) as {
            n: number;
          }
        ).n;
      expect(ftsHits(live, "fakeperson")).toBeGreaterThan(0);
      closeStore(live);

      const copy = openCopy(pair);
      expect(ftsHits(copy, "fakeperson")).toBe(0);
      expect(ftsHits(copy, "home")).toBeGreaterThan(0);
      const text = (copy.db.prepare("SELECT content FROM fact_versions").all() as { content: string }[]).map(
        (r) => r.content,
      );
      expect(text.some((t) => t.includes(`${REPLACEMENT}\\notes`))).toBe(true);
      expect(findTerms(text.join("\n"), [FAKE_HOME])).toEqual([]);
      closeStore(copy);
      const bytes = readFileSync(join(pair.target, "demo/wikifact/game.sqlite")).toString("latin1").toLowerCase();
      expect(bytes).not.toContain("fakeperson");
    },
    TIMEOUT,
  );

  it(
    "Real demo",
    async () => {
      const fx = makeFixture();
      await exportPublic(fx.root, fx.target);
      expect(tracked(fx)).toContain("demo/wikifact/game.sqlite");
      expect(tracked(fx)).toContain("demo/wikifact/wikifact.json");

      // No exception line in .gitignore: the store is tracked by force, and the folder `wikis/` of the served copy
      // is ignored, so a search leaves the clone clean.
      const ignoreLines = read(fx, ".gitignore").split("\n");
      expect(ignoreLines.filter((l) => l.startsWith("!"))).toEqual([]);
      expect(ignoreLines).toContain("wikis/");

      // The wiki config: the mode that needs the key of the reader, and the subject of the live wiki.
      expect(JSON.parse(read(fx, "demo/wikifact/wikifact.json"))).toMatchObject({
        mode: "deployed",
        subject: "A fake subject",
      });

      const copy = openCopy(fx);
      const count = (table: string): number =>
        (copy.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      for (const table of ["sessions", "searches", "search_results", "tool_calls", "model_calls", "retrievals"]) {
        expect(count(table)).toBe(0);
      }
      expect(readQueuePause(copy)).toBeUndefined();

      // The state of the service does not reach the copy: the worker status of `meta` and the staging tables, which
      // hold a private term in the live store.
      expect(copy.db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'worker_status'").get()).toEqual({ n: 0 });
      expect(count("stg_fact_versions")).toBe(0);
      const bytes = readFileSync(join(fx.target, "demo/wikifact/game.sqlite")).toString("latin1").toLowerCase();
      expect(bytes).not.toContain("zorblax");

      // The facts and the change requests stay; a change request no longer points at a session or a search.
      expect(countFacts(copy)).toBe(2);
      expect(count("fact_versions")).toBe(2);
      expect(count("change_requests")).toBe(1);
      expect(copy.db.prepare("SELECT session_id, search_id FROM change_requests").get()).toEqual({
        session_id: null,
        search_id: null,
      });

      // A search on the copy returns a fact.
      const hits = await search(copy, "creeper damage");
      expect(hits.map((h) => h.header)).toContain("Creeper damage");
      closeStore(copy);

      // The live store keeps its use rows: the export reads it and writes nothing.
      const live = openStore(fx.dbPath, { embeddingModel: FIXTURE_MODEL }, { readonly: true });
      expect((live.db.prepare("SELECT count(*) AS n FROM searches").get() as { n: number }).n).toBe(1);
      closeStore(live);
    },
    TIMEOUT,
  );

  it("README for readers", () => {
    const readme = repoText("publication/README.md");
    // The text before the first section states the aim and that it works without human supervision, and the quickstart
    // names the Node version.
    const intro = readme.split(/^## /m)[0] ?? "";
    expect(intro).toMatch(/AI (coding )?agents/i);
    expect(intro).toMatch(/MCP/i);
    expect(intro).toMatch(/without human|no human/i);
    expect(sectionOf(readme, 2, "Run the demo") ?? "").toMatch(/Node 22/i);
    for (const title of ["How it works", "Interesting findings", "Limits", "License"]) {
      expect(sectionOf(readme, 2, title), title).toBeDefined();
    }
    // The Limits section states the limits: at least 3 bullets of the form "- **<label>.**".
    const limits = sectionOf(readme, 2, "Limits") ?? "";
    expect(limits.match(/^- \*\*[^*]+\.\*\*/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("How it works", () => {
    const readme = repoText("publication/README.md");
    const section = sectionOf(readme, 2, "How it works") ?? "";
    expect(section).toMatch(/update request/i);
    expect(section).toMatch(/narrow/i);
    expect(section).toMatch(/correct/i);
    expect(section).toMatch(/wrong fact|stale/i);
  });

  it("Detailed findings", () => {
    const measured = sectionOf(repoText("publication/README.md"), 2, "Interesting findings") ?? "";
    const findings = [...measured.matchAll(/^### (\d+)\. .*$/gm)];
    expect(findings.length).toBeGreaterThan(0);

    const rules = loadExportRules(join(REPO_ROOT, "publication/export.json"));
    for (const [index, match] of findings.entries()) {
      const end = findings[index + 1]?.index ?? measured.length;
      const body = measured.slice(match.index, end);
      expect(body, match[0]).toMatch(/\d/);

      const links = [...body.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((m) => (m[1] ?? "").split(/[#?]/)[0] ?? "")
        .filter((target) => target.startsWith("docs/research/"));
      expect(links.length, match[0]).toBeGreaterThan(0);
      for (const link of links) {
        expect(existsSync(join(REPO_ROOT, link)), link).toBe(true);
        expect(isExcluded(link, rules), link).toBe(false);
      }
    }
  });

  it("Decision citations", () => {
    const rules = loadExportRules(join(REPO_ROOT, "publication/export.json"));
    const files = git(REPO_ROOT, ["ls-files"])
      .split("\n")
      .filter((f) => f !== "" && !f.startsWith("docs/decisions/") && !isExcluded(f, rules))
      // A result file is the recorded output of a model run; no one rewrites it.
      .filter((f) => !(f.endsWith(".json") && rules.resultFolders.some((folder) => f.startsWith(`${folder}/`))));
    const bad = files.flatMap((f) => {
      const bytes = readFileSync(join(REPO_ROOT, f));
      // A binary file is not text; the export refuses it unless the rules allow it.
      if (bytes.includes(0)) return [];
      const text = bytes.toString("utf8");
      const lines = [
        ...(f.endsWith(".md") ? decisionLinksOutsideLists(f, text) : []),
        ...plainDecisionMentions(f, text),
      ];
      return lines.map((line) => `${f}:${line}`);
    });
    expect(bad).toEqual([]);
  });

  it(
    "Consumer plugin",
    async () => {
      const json = (path: string): unknown => JSON.parse(repoText(path));
      // The marketplace names the plugin folder.
      expect(json(".claude-plugin/marketplace.json")).toMatchObject({
        name: "wikifact",
        owner: { name: "Arkased" },
        plugins: [{ name: "wikifact", source: "./plugin" }],
      });
      // The manifest, the MCP entry and the hooks.
      expect(json("plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "wikifact" });
      expect(json("plugin/.mcp.json")).toEqual({
        mcpServers: { wikifact: { type: "http", url: "http://127.0.0.1:7777/mcp" } },
      });
      const hooks = (
        json("plugin/hooks/hooks.json") as {
          hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
        }
      ).hooks;
      const commands = (event: string): string[] => (hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
      const run = (file: string): string => `node "\${CLAUDE_PLUGIN_ROOT}/dist/${file}"`;
      expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "SessionStart", "SubagentStart", "SubagentStop"]);
      expect(commands("SessionStart")).toEqual([run("wiki-context.js")]);
      expect(commands("SubagentStart")).toEqual([run("wiki-context.js")]);
      expect(commands("SubagentStop")).toEqual([run("wiki-submit.js")]);
      expect(commands("PreToolUse")).toEqual([run("wiki-submit.js")]);
      expect(hooks.PreToolUse?.map((g) => g.matcher)).toEqual(["SubagentHandback"]);
      // Each hook command names a built file, and the setup command runs the built setup.
      for (const command of Object.keys(hooks).flatMap(commands)) {
        const file = /\/dist\/([^"]+)"/.exec(command)?.[1] ?? "";
        expect(existsSync(join(REPO_ROOT, "plugin/dist", file)), command).toBe(true);
      }
      expect(existsSync(join(REPO_ROOT, "plugin/dist/setup.js"))).toBe(true);
      expect(repoText("plugin/commands/setup.md")).toContain("dist/setup.js");

      // The export copies the plugin and the marketplace file.
      const fx = makeFixture();
      writeFiles(fx.root, {
        ".claude-plugin/marketplace.json": repoText(".claude-plugin/marketplace.json"),
        "plugin/.claude-plugin/plugin.json": repoText("plugin/.claude-plugin/plugin.json"),
        "plugin/dist/setup.js": "// bundle\n",
      });
      commitAll(fx.root, "add the plugin");
      await exportPublic(fx.root, fx.target);
      expect(tracked(fx)).toEqual(
        expect.arrayContaining([
          ".claude-plugin/marketplace.json",
          "plugin/.claude-plugin/plugin.json",
          "plugin/dist/setup.js",
        ]),
      );
    },
    TIMEOUT,
  );

  it("Open license", () => {
    expect(repoText("LICENSE")).toContain("MIT License");
    expect(JSON.parse(repoText("package.json"))).toMatchObject({ license: "MIT" });
  });
});
