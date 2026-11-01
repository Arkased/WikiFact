// Usage: npm run console:timing -- [N]
// Seeds a temporary wiki with N synthetic facts (default 10,000) through the fake embedder, renders every console
// page once, and writes reports/console-timing.md with the wall time of each page against the 1,000 ms bar of
// technical/console.md, "Non-functional rules". Exit code 1 when a page is at or over the bar. A manual tool: it calls no model.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BAR_MS, slowPages, type TimedPage as Timed } from "./lib/console-timing.js";
import { seedFacts } from "../eval/speed/seed.js";
import { fakeEmbed } from "../fakes/fake-embedder.js";
import { loadPrices, parseConfig } from "../src/config/index.js";
import { noWikiWrites, type ConsoleDeps, type ConsoleWiki } from "../src/console/deps.js";
import type { PageContext, PageHandler } from "../src/console/page.js";
import { exportPage } from "../src/console/pages/export.js";
import { factPage } from "../src/console/pages/fact.js";
import { healthPage } from "../src/console/pages/health.js";
import { requestPage } from "../src/console/pages/request.js";
import { requestsPage } from "../src/console/pages/requests.js";
import { searchPage } from "../src/console/pages/search.js";
import { settingsPage } from "../src/console/pages/settings.js";
import { overviewPage } from "../src/console/pages/overview.js";
import { wikisPage } from "../src/console/pages/wikis.js";
import { ExportFormat, FactListSort, Mode, ServeTarget, Span } from "../src/domain/enums.js";
import { setEmbedder } from "../src/embed/index.js";
import { projectRoot, WIKI_DB_FILE } from "../src/paths.js";
import { closeStore, listFacts, listRequests, openStoreFor } from "../src/store/index.js";
import { RM_RETRY_DELAY_MS } from "../src/constants.js";

/** The fact count when the command line gives none. */
const DEFAULT_FACTS = 10_000;
/** Retries of `rmSync` for the folder of the seeded wiki, which the open database keeps busy for longer. */
const RM_RETRIES_LONG = 10;

async function timePage(name: string, handler: PageHandler, ctx: PageContext, out: Timed[]): Promise<void> {
  const t0 = performance.now();
  await handler(ctx);
  out.push({ page: name, ms: Math.round(performance.now() - t0) });
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? DEFAULT_FACTS);
  setEmbedder(fakeEmbed);
  const dir = mkdtempSync(join(tmpdir(), "wikifact-console-timing-"));
  const logDir = join(dir, "logs");
  mkdirSync(logDir);
  const config = parseConfig({ mode: Mode.Local, subject: "A synthetic wiki for the console timing." });
  const dbPath = join(dir, WIKI_DB_FILE);
  const store = openStoreFor(config, dbPath);
  try {
    await seedFacts(store, { from: 0, n }, (line) => process.stderr.write(`${line}\n`));
    const now = Date.now();
    const name = "timing";
    const wiki: ConsoleWiki = {
      name,
      config,
      dbPath,
      url: `http://127.0.0.1:1/wikis/${name}/mcp`,
      subject: config.subject,
    };
    const deps: ConsoleDeps = {
      listWikis: () => [wiki],
      getWiki: (w) => (w === name ? wiki : undefined),
      service: () => ({
        version: "timing",
        startedAt: now,
        host: "127.0.0.1",
        port: 1,
        mode: Mode.Local,
        // One database and no registry, as `serve --db`: the writes refuse, so the settings page shows no form.
        target: ServeTarget.Db,
        path: dbPath,
        logDir,
        archives: [],
      }),
      writes: noWikiWrites(),
      prices: loadPrices(),
      log: () => undefined,
    };
    const ctx = (params: Record<string, string> = {}, query = ""): PageContext => ({
      deps,
      params: { w: name, ...params },
      query: new URLSearchParams(query),
    });
    const firstFact = listFacts(store, { now, sort: FactListSort.Header }).items[0];
    const firstRequest = listRequests(store, {}).items[0];
    if (!firstFact || !firstRequest) throw new Error("the seed left an empty wiki");

    const out: Timed[] = [];
    await timePage("wikis", wikisPage, ctx(), out);
    await timePage("overview, recent", overviewPage, ctx(), out);
    await timePage("overview, all", overviewPage, ctx({}, `span=${Span.All}`), out);
    await timePage("operation", healthPage, ctx(), out);
    await timePage("search", searchPage, ctx({}, "q=world+damage"), out);
    await timePage("search with history", searchPage, ctx({}, "q=world+damage&history=1"), out);
    await timePage("search, random sample", searchPage, ctx({}, "sample=1"), out);
    await timePage("fact page", factPage, ctx({ id: firstFact.id }), out);
    await timePage("requests", requestsPage, ctx(), out);
    await timePage("request page", requestPage, ctx({ id: firstRequest.id }), out);
    await timePage("settings", settingsPage, ctx(), out);
    await timePage("export json", exportPage, ctx({}, `format=${ExportFormat.Json}`), out);
    await timePage("export markdown", exportPage, ctx({}, `format=${ExportFormat.Md}`), out);

    const lines = [
      "# Console page timing",
      "",
      `Every page of technical/console.md, "Pages" rendered once on a wiki of ${n} synthetic facts, seeded with the fake`,
      `embedder, through the page handlers in-process with no HTTP. The bar is ${BAR_MS} ms (technical/console.md, "Non-functional rules").`,
      `Written by \`npm run console:timing\` on ${new Date().toISOString()}; Node ${process.version} on ${process.platform}.`,
      "",
      "| Page | ms | Under the bar |",
      "|---|---|---|",
      ...out.map((t) => `| ${t.page} | ${t.ms} | ${t.ms < BAR_MS ? "yes" : "no"} |`),
      "",
    ];
    const outPath = join(projectRoot(), "reports", "console-timing.md");
    writeFileSync(outPath, lines.join("\n"));
    process.stdout.write(lines.join("\n"));
    const slow = slowPages(out, BAR_MS);
    for (const t of slow) process.stderr.write(`slow page: ${t.page} took ${t.ms} ms (bar ${BAR_MS} ms)\n`);
    if (slow.length > 0) process.exitCode = 1;
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES_LONG, retryDelay: RM_RETRY_DELAY_MS });
  }
}

await main();
