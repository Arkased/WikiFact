// The browser test of technical/console.md, "Browser test": the console served from a seeded temporary wikis folder with the compiled
// browser script, driven through playwright-core on the Edge or Chrome of the machine. The whole file is skipped, with
// the reason in its name, when neither browser launches.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { BrowserChannel } from "../eval/lib/enums.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/index.js";
import { registryDeps } from "../src/console/deps.js";
import { consoleRoute } from "../src/console/routes.js";
import { McpToolName, Mode } from "../src/domain/enums.js";
import { startHttpServer, type HttpHandle } from "../src/mcp/http.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../src/paths.js";
import { createWikiRegistry, discoverWikis, type WikiRegistry } from "../src/service/registry.js";
import {
  applyChangeSync,
  closeStore,
  enqueueRequest,
  openStoreFor,
  recordSearch,
  recordToolCall,
  writeWorkerStatus,
} from "../src/store/index.js";
import { must } from "./helpers/must.js";
import { accepted, draft } from "./helpers/store.js";

const ROOT = resolve(import.meta.dirname, "..");
/** The time one test may take, in ms: a page load in a real browser. */
const TEST_TIMEOUT_MS = 30_000;
/** The time `beforeAll` may take, in ms: the client build and the seeding. */
const HOOK_TIMEOUT_MS = 60_000;
/** The wait of the refresh case, in ms: longer than the 15 s refresh period of technical/console.md, "Requests". */
const REFRESH_WAIT_MS = 16_000;
/** The desktop viewport width, in px. */
const WIDE = 1440;
/** The narrow viewport width, in px. */
const NARROW = 720;
/** The viewport height of both, in px. */
const VIEW_HEIGHT = 900;
/** The most results the random sample shows (technical/console.md, "Search"). */
const SAMPLE_SIZE = 10;
/** How far ahead of the clock the seeded worker poll is, in ms. */
const FUTURE_POLL_MS = 3_600_000;
/** The time one browser action may take, in ms. */
const ACTION_TIMEOUT_MS = 10_000;
const CHANNELS = [BrowserChannel.Edge, BrowserChannel.Chrome];
/** The one wiki the test seeds. */
const WIKI = "alpha";
/** The tabs of the top bar, in order (technical/console.md, "The shell"). */
const TABS = ["Overview", "Operation"];
/** The tools of the More menu, in order, with the export link after them. */
const TOOLS = ["Search", "Requests", "Settings", "Export"];

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS });

// The first browser channel that launches, or undefined when none does.
async function launchBrowser(): Promise<Browser | undefined> {
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // A channel that is not installed throws on launch; the next one may be.
    }
  }
  return undefined;
}

const browser = await launchBrowser();

/** The ids the seeded wiki gives to the pages that name an object. */
interface Seeded {
  factId: string;
  requestId: string;
}

let dir: string;
let scriptDir: string;
let registry: WikiRegistry;
let handle: HttpHandle;
let base: string;
let seeded: Seeded;

// Compiles the browser script into `outDir` and returns the path of the `console.js` found under it.
function buildScript(outDir: string): string {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const run = spawnSync(process.execPath, [tsc, "-p", "tsconfig.client.json", "--outDir", outDir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`tsc failed:\n${run.stdout}${run.stderr}`);
  const found = readdirSync(outDir, { recursive: true, encoding: "utf8" }).find((f) => /(^|[\\/])console\.js$/.test(f));
  if (found === undefined) throw new Error(`no console.js under ${outDir}`);
  return join(outDir, found);
}

/** The searches of the seeded wiki, so that the stage chart has positions to hover. */
const SEEDED_SEARCHES = 5;

// Seeds the wiki: 3 facts (one corrected so it has 2 versions), a queued request, and a few searches.
function seedWiki(wikisDir: string): Seeded {
  const folder = join(wikisDir, WIKI);
  mkdirSync(folder);
  const raw = { mode: Mode.Local, subject: "A test wiki." };
  writeFileSync(join(folder, WIKI_CONFIG_FILE), JSON.stringify(raw));
  const store = openStoreFor(parseConfig(raw), join(folder, WIKI_DB_FILE));
  try {
    const now = Date.now();
    const first = enqueueRequest(store, { change: "Creepers and zombies", justification: "I saw it" }, now);
    const a = applyChangeSync(
      store,
      first,
      accepted([
        draft({ header: "Creeper damage", content: "Creepers do 10 damage." }),
        draft({ header: "Zombie speed", content: "Zombies walk slowly." }),
        draft({ header: "Lonely note", content: "Nothing tags this note." }),
      ]),
      { now },
    );
    const factId = a.factIds[0] ?? "";
    const second = enqueueRequest(store, { change: "Creepers do 12", justification: "Measured again" }, now + 1);
    applyChangeSync(
      store,
      second,
      accepted([draft({ factId, header: "Creeper damage", content: "Creepers do 12 damage." })]),
      { now: now + 1 },
    );
    enqueueRequest(store, { change: "A queued thing", justification: "later" }, now + 2);
    for (const n of [3, 4]) enqueueRequest(store, { change: `Queued ${n}`, justification: "j" }, now + n);
    // The service runs no worker here. A poll set ahead of the clock stays inside the 60 s window for the whole run,
    // so the worker row, and with it the status pill, is green.
    writeWorkerStatus(store, {
      pid: process.pid,
      startedAt: now,
      lastPollAt: now + FUTURE_POLL_MS,
      consecutiveFailures: 0,
    });
    // The searches start with the requests: a request before the first search counts nowhere, so this is how the stage
    // chart gets points with change requests in them.
    for (let i = 0; i < SEEDED_SEARCHES; i++) {
      recordSearch(store, {
        id: `search-${i}`,
        sessionId: null,
        query: "q",
        at: now + i,
        durationMs: 1,
        results: [],
      });
    }
    return { factId, requestId: second };
  } finally {
    closeStore(store);
  }
}

// Runs `body` on a fresh page of the given width and closes the page after.
async function withPage(body: (page: Page) => Promise<void>, width = WIDE): Promise<void> {
  if (browser === undefined) throw new Error("no browser");
  const page = await browser.newPage({ viewport: { width, height: VIEW_HEIGHT } });
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  try {
    await body(page);
  } finally {
    await page.close();
  }
}

const wikiPath = (rest = ""): string => `${base}/console/w/${WIKI}${rest}`;

// The element that has the focus: its tag name, its class, its data-dialog and whether it sits in a dialog; the strings
// are "" when no element has the focus.
function focused(page: Page): Promise<{ tag: string; cls: string; dialog: string; inDialog: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? "",
      cls: el?.className.toString() ?? "",
      dialog: el?.getAttribute("data-dialog") ?? "",
      inDialog: el?.closest("dialog") != null,
    };
  });
}

function menuOpen(page: Page, cls: string): Promise<boolean> {
  return page.locator(`details.menu.${cls}`).evaluate((el) => el instanceof HTMLDetailsElement && el.open);
}

describe.skipIf(browser === undefined)(
  "console UI in a real browser (skipped: neither Edge nor Chrome launches)",
  () => {
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "wikifact-console-ui-"));
      scriptDir = mkdtempSync(join(tmpdir(), "wikifact-console-js-"));
      const scriptFile = buildScript(scriptDir);
      const wikisDir = join(dir, "wikis");
      mkdirSync(wikisDir);
      seeded = seedWiki(wikisDir);
      registry = createWikiRegistry({
        wikisDir,
        host: "127.0.0.1",
        withWorker: false,
        log: () => undefined,
        baseUrl: () => base,
      });
      for (const w of discoverWikis(wikisDir)) registry.mount(w);
      // Calls of the endpoint, so that the charts of Service health have an hour to hover.
      const { store } = must(registry.get(WIKI));
      recordToolCall(store, { at: Date.now(), tool: McpToolName.Search, ok: true, durationMs: 5 });
      recordToolCall(store, { at: Date.now(), tool: McpToolName.GetFact, ok: true, durationMs: 1 });
      // A request the worker finished in the last hour, so that the chart of the processed requests has a bar.
      store.db
        .prepare(
          "UPDATE change_requests SET status = 'done', started_at = ?, finished_at = ? WHERE id = (SELECT request_id FROM changes ORDER BY seq LIMIT 1)",
        )
        .run(Date.now() - 1000, Date.now());
      const log = (): void => undefined;
      return startHttpServer(consoleRoute(registryDeps(registry, log), { scriptFile }), {
        host: "127.0.0.1",
        port: 0,
        log,
      }).then((h) => {
        handle = h;
        base = `http://127.0.0.1:${h.port}`;
      });
    });

    afterAll(async () => {
      await browser?.close();
      await new Promise((r) => handle.server.close(r));
      registry.stop();
    });

    it("Shell: every page answers 200 with the top bar, the current tab marked and no horizontal scroll at 1440 and 720 px", async () => {
      const pages: { path: string; marked: boolean }[] = [
        { path: `${base}/console/`, marked: false },
        { path: wikiPath(), marked: true },
        { path: wikiPath("?span=all"), marked: true },
        { path: wikiPath("/health"), marked: true },
        { path: wikiPath("/search"), marked: true },
        { path: wikiPath(`/facts/${seeded.factId}`), marked: true },
        { path: wikiPath("/requests"), marked: true },
        { path: wikiPath(`/requests/${seeded.requestId}`), marked: true },
        { path: wikiPath("/settings"), marked: true },
      ];
      for (const width of [WIDE, NARROW]) {
        await withPage(async (page) => {
          for (const p of pages) {
            const res = await page.goto(p.path);
            expect(res?.status(), `${p.path} at ${width}`).toBe(200);
            await expect(page.locator("header.app a.brand").isVisible(), p.path).resolves.toBe(true);
            if (p.marked) {
              const current = await page.locator("header.app [aria-current]").count();
              expect(current, `a current tab or menu item on ${p.path}`).toBeGreaterThan(0);
            }
            const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
            expect(fits, `no horizontal scroll on ${p.path} at ${width}`).toBe(true);
          }
          const paths = [wikiPath(), wikiPath("/health")];
          for (const [i, tab] of TABS.entries()) {
            await page.goto(paths[i] ?? "");
            expect(await page.locator("nav.tabs a").allInnerTexts()).toEqual(TABS);
            const marked = await page.locator('nav.tabs a[aria-current="page"]').innerText();
            expect(marked).toBe(tab);
          }
        }, width);
      }
    });

    it("Stable gutter: the brand link stays at the same x on a short page (Search) and on a tall page that scrolls (Overview)", async () => {
      await withPage(async (page) => {
        const brandX = async (path: string): Promise<{ x: number; scrolls: boolean }> => {
          await page.goto(path);
          return {
            x: await page.locator("header.app a.brand").evaluate((el) => el.getBoundingClientRect().x),
            scrolls: await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
          };
        };
        const jobs = await brandX(wikiPath("/search"));
        const overview = await brandX(wikiPath());
        // The proof holds only when the tall page really scrolls and the short one does not.
        expect(overview.scrolls).toBe(true);
        expect(jobs.scrolls).toBe(false);
        expect(overview.x).toBe(jobs.x);
      });
    });

    it("Wiki switcher and More menu: click opens, outside click closes, Escape closes and focuses the summary, opening one closes the other", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath());
        await page.locator("details.menu.wiki > summary").click();
        expect(await menuOpen(page, "wiki")).toBe(true);
        await page.locator("main").click({ position: { x: 5, y: 5 } });
        expect(await menuOpen(page, "wiki")).toBe(false);

        await page.locator("details.menu.more > summary").click();
        expect(await menuOpen(page, "more")).toBe(true);
        // The More menu holds the tools, then the export link, then the version.
        const tools = await page.locator("details.menu.more div.menu-list a").allInnerTexts();
        expect(tools).toEqual(TOOLS);
        await page.keyboard.press("Escape");
        expect(await menuOpen(page, "more")).toBe(false);
        const active = await focused(page);
        expect(active.tag).toBe("SUMMARY");
        const inMore = await page.evaluate(() => document.activeElement?.closest("details.menu.more") != null);
        expect(inMore).toBe(true);

        await page.locator("details.menu.wiki > summary").click();
        await page.locator("details.menu.more > summary").click();
        expect(await menuOpen(page, "more")).toBe(true);
        expect(await menuOpen(page, "wiki")).toBe(false);
      });
    });

    it("Status pill: it links to Service health and reads ok on the seeded wiki", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath());
        const pill = page.locator("header.app a.status");
        expect(await pill.getAttribute("href")).toBe(`/console/w/${WIKI}/health`);
        expect((await pill.innerText()).trim()).toBe("ok");
      });
    });

    it("Span control: a click on All loads ?span=all, the segment is current and the 3 blocks show, the stage second", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath());
        await page.locator("nav.segmented a", { hasText: "All" }).click();
        await page.waitForURL(/span=all/);
        expect(await page.locator('nav.segmented a[aria-current="true"]').innerText()).toBe("All");
        const blocks = await page.locator("main section.panel > header h2").allInnerTexts();
        expect(blocks).toEqual(["Search quality", "Wiki growth", "Cost"]);
      });
    });

    it("Layout: a stat has a fixed width and starts at the left of its panel, a panel has 1 hairline under its head, a key column is 140 px", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/health"));
        const stats = page.locator("section.panel div.stats").first();
        const stat = stats.locator(".stat");
        const [row, first, second] = await Promise.all([
          stats.boundingBox(),
          stat.nth(0).boundingBox(),
          stat.nth(1).boundingBox(),
        ]);
        const width = first?.width ?? 0;
        expect(width).toBeGreaterThanOrEqual(120);
        expect(width).toBeLessThanOrEqual(280);
        expect(first?.x).toBe(row?.x);
        // The 3 stats of a half-width panel sit on one line.
        const failures = page
          .locator("section.panel", { hasText: "Queue worker, 24 hours" })
          .locator("div.stats .stat");
        expect(await failures.count()).toBe(3);
        const ys = await Promise.all([0, 1, 2].map(async (i) => (await failures.nth(i).boundingBox())?.y));
        expect(new Set(ys).size).toBe(1);
        // The second stat follows the first at a fixed gap, it is not stretched across the panel.
        expect((second?.x ?? 0) - ((first?.x ?? 0) + width)).toBeLessThanOrEqual(40);
        // No hairline of its own around the stat row.
        const lines = await stats.evaluate((el) => {
          const s = getComputedStyle(el);
          return [s.borderTopWidth, s.borderBottomWidth];
        });
        expect(lines).toEqual(["0px", "0px"]);
        const head = await page
          .locator("section.panel > header.panel-head")
          .first()
          .evaluate((el) => getComputedStyle(el).borderBottomWidth);
        expect(head).toBe("1px");
      });
      await withPage(async (page) => {
        await page.goto(wikiPath(`/requests/${seeded.requestId}`));
        for (const dt of await page.locator("dl.kv dt").all()) {
          expect((await dt.boundingBox())?.width).toBe(140);
        }
      });
    });

    it("Operation layout: the MCP server and the queue worker side by side, each with its present above its 24 hours, and the 2 charts of a column share their x positions", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/health"));
        const panel = (title: string) =>
          page.locator("section.panel", { has: page.getByRole("heading", { name: title, exact: true }) });
        const [mcpNow, mcpDay, workerNow, workerDay, jobs] = await Promise.all(
          ["MCP server, now", "MCP server, 24 hours", "Queue worker, now", "Queue worker, 24 hours", "Jobs"].map(
            async (title) => panel(title).boundingBox(),
          ),
        );
        // The columns sit side by side at the same top, the present over the history in each, and the jobs under both at full width.
        expect(mcpNow?.y).toBe(workerNow?.y);
        expect(mcpNow?.x).toBe(mcpDay?.x);
        expect(workerNow?.x).toBe(workerDay?.x);
        expect(workerNow?.x ?? 0).toBeGreaterThan((mcpNow?.x ?? 0) + (mcpNow?.width ?? 0) - 1);
        expect(mcpDay?.y ?? 0).toBeGreaterThan((mcpNow?.y ?? 0) + (mcpNow?.height ?? 0) - 1);
        expect(workerDay?.y ?? 0).toBeGreaterThan((workerNow?.y ?? 0) + (workerNow?.height ?? 0) - 1);
        expect(jobs?.y ?? 0).toBeGreaterThan(
          Math.max((mcpDay?.y ?? 0) + (mcpDay?.height ?? 0), (workerDay?.y ?? 0) + (workerDay?.height ?? 0)) - 1,
        );
        expect(jobs?.width ?? 0).toBeGreaterThan((mcpNow?.width ?? 0) * 1.9);
        // The 2 charts of a column share the x positions of their hours.
        for (const title of ["MCP server, 24 hours", "Queue worker, 24 hours"]) {
          const xs = await panel(title)
            .locator("svg.chart")
            .evaluateAll((svgs) =>
              svgs.map((svg) =>
                [...svg.querySelectorAll("g.slot line.cursor")].map((l) =>
                  Math.round(l.getBoundingClientRect().x - svg.getBoundingClientRect().x),
                ),
              ),
            );
          // The seed has calls, finished requests and a queued request, so both charts of each column are drawn.
          expect(xs, title).toHaveLength(2);
          expect(xs[0]?.length, title).toBeGreaterThan(0);
          expect(xs[0], title).toEqual(xs[1]);
        }
      });
    });

    it("Operation rows: the 2 panels of a row share their top and their height, and a head with the button is as tall as a head without one", async () => {
      // The wide viewport, and the narrowest one that keeps the 2 columns (a narrow half-width head).
      for (const width of [WIDE, 900]) {
        await withPage(async (page) => {
          await page.goto(wikiPath("/health"));
          const panel = (title: string) =>
            page.locator("section.panel", { has: page.getByRole("heading", { name: title, exact: true }) });
          const head = (title: string) => panel(title).locator("> header.panel-head").boundingBox();
          for (const [left, right] of [
            ["MCP server, now", "Queue worker, now"],
            ["MCP server, 24 hours", "Queue worker, 24 hours"],
          ] as const) {
            const [a, b] = await Promise.all([panel(left).boundingBox(), panel(right).boundingBox()]);
            expect(a?.y, left).toBe(b?.y);
            expect(a?.height, left).toBe(b?.height);
          }
          // The worker head holds the 2 buttons, Mode and Pause; the MCP head holds none.
          expect(await panel("Queue worker, now").locator("header.panel-head .aside button").count()).toBe(2);
          expect(await panel("MCP server, now").locator("header.panel-head .aside").count()).toBe(0);
          const [withButton, without] = await Promise.all([head("Queue worker, now"), head("MCP server, now")]);
          expect(withButton?.height).toBe(without?.height);
          // The button stays inside the head box: it does not spill over the hairline.
          const button = await panel("Queue worker, now")
            .locator("header.panel-head .aside button")
            .first()
            .boundingBox();
          const box = await panel("Queue worker, now").boundingBox();
          expect(button?.y ?? 0).toBeGreaterThanOrEqual(box?.y ?? 0);
          expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThanOrEqual(
            (withButton?.y ?? 0) + (withButton?.height ?? 0),
          );
        }, width);
      }
    });

    it("Search: / focuses the box, Enter loads ?q=, the seeded fact shows, Escape clears, Random sample works", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/search"));
        await page.keyboard.press("/");
        const box = page.locator("[data-search]");
        expect(await box.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.type("Creepers do damage");
        await page.keyboard.press("Enter");
        await page.waitForURL(/q=/);
        await expect(page.locator("ol.results").innerText()).resolves.toContain("Creepers do 12 damage.");

        await page.keyboard.press("/");
        await page.keyboard.press("Escape");
        expect(await box.inputValue()).toBe("");

        await page.locator("a", { hasText: "Random sample" }).click();
        await page.waitForURL(/sample=1/);
        expect(await page.locator("ol.results li.result").count()).toBeLessThanOrEqual(SAMPLE_SIZE);
        // The page has no ranking view.
        await page.goto(wikiPath("/search?q=Creepers"));
        expect(await page.locator("label.field", { hasText: "show ranking" }).count()).toBe(0);
      });
    });

    it("Toolbar: an outcome select change loads ?outcome= with the applied chip, and the chip removes the filter", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/requests"));
        await page.locator("select[name=outcome]").selectOption({ value: "accepted" });
        await page.waitForURL(/outcome=/);
        const chip = page.locator("ul.applied a.chip.remove");
        expect(await chip.innerText()).toContain("accepted");
        await chip.click();
        await page.waitForURL((url) => !url.search.includes("outcome="));
        expect(await page.locator("ul.applied").count()).toBe(0);
      });
    });

    it("Sort: a click on a column header sets aria-sort on the th and the URL", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/requests"));
        await page.locator("th a", { hasText: "Duration" }).click();
        await page.waitForURL(/sort=/);
        const sorted = await page.locator('th[aria-sort="ascending"], th[aria-sort="descending"]').innerText();
        expect(sorted).toContain("Duration");
      });
    });

    it("Dialog: Run on a Jobs row opens it with the focus in the first field, Escape closes it and returns the focus, Cancel closes it", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/health"));
        const open = page.locator("button[data-dialog]", { hasText: /^Run$/ }).first();
        // The label sits on 1 line.
        expect(await open.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
        // The row action is compact, and the Run buttons of the column align.
        expect(await open.evaluate((el) => getComputedStyle(el).padding)).toBe("4px 10px");
        const xs = await page
          .locator("td.act button")
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
        expect(new Set(xs.map((x) => Math.round(x))).size).toBe(1);
        await open.click();
        const dialog = page.getByRole("dialog", { name: /\S/ });
        expect(await dialog.isVisible()).toBe(true);
        const first = await page.evaluate(() => {
          const el = document.activeElement;
          return { field: el?.matches("input, textarea, select") ?? false, inDialog: el?.closest("dialog") != null };
        });
        expect(first).toEqual({ field: true, inDialog: true });

        await page.keyboard.press("Escape");
        expect(await page.locator("dialog[open]").count()).toBe(0);
        const back = await focused(page);
        expect(back.tag).toBe("BUTTON");
        expect(back.dialog).not.toBe("");

        await open.click();
        await dialog.locator("button", { hasText: "Cancel" }).click();
        expect(await page.locator("dialog[open]").count()).toBe(0);
      });
    });

    it("Dialog: Pause in the head of Queue worker, now opens it with the focus in the first field, Escape closes it", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/health"));
        const panel = page.locator("section", { has: page.getByRole("heading", { name: "Queue worker, now" }) });
        const open = panel.getByRole("button", { name: "Pause", exact: true });
        // The control is compact and default: the same size and padding as the Run button of Jobs.
        const size = (el: Element): { height: number; padding: string } => ({
          height: el.getBoundingClientRect().height,
          padding: getComputedStyle(el).padding,
        });
        const pauseSize = await open.evaluate(size);
        const runSize = await page.getByRole("button", { name: "Run", exact: true }).first().evaluate(size);
        expect(pauseSize).toEqual(runSize);
        await open.click();
        expect(await page.getByRole("dialog", { name: "Pause the queue" }).isVisible()).toBe(true);
        const first = await page.evaluate(() => {
          const el = document.activeElement;
          return { field: el?.matches("input, textarea, select") ?? false, inDialog: el?.closest("dialog") != null };
        });
        expect(first).toEqual({ field: true, inDialog: true });
        await page.keyboard.press("Escape");
        expect(await page.locator("dialog[open]").count()).toBe(0);
      });
    });

    it("Button: Run a batch now in Queue worker, now is enabled with queued submissions and opens no dialog", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath("/health"));
        const panel = page.locator("section", { has: page.getByRole("heading", { name: "Queue worker, now" }) });
        const button = panel.getByRole("button", { name: "Run a batch now", exact: true });
        expect(await button.isEnabled()).toBe(true);
        expect(await page.locator("dialog[open]").count()).toBe(0);
      });
    });

    it("Fold: Diff and reasoning on a history entry opens the diff", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath(`/facts/${seeded.factId}`));
        const fold = page.locator("ol.timeline details.fold", { hasText: "Diff and reasoning" }).first();
        await fold.locator("summary").click();
        expect(await fold.evaluate((el) => el instanceof HTMLDetailsElement && el.open)).toBe(true);
        await expect(fold.locator("ins").first().isVisible()).resolves.toBe(true);
      });
    });

    it("Tooltip: a hover over a slot of the stage chart and over a slot of the calls chart shows div.tooltip with their lines, and a move out hides it", async () => {
      await withPage(async (page) => {
        for (const path of [wikiPath(), wikiPath("/health")]) {
          await page.goto(path);
          await page.locator("g.slot rect.hit").first().hover({ force: true });
          const tip = page.locator("div.tooltip");
          await expect(tip.isVisible(), path).resolves.toBe(true);
          const lines = (await tip.evaluate((el) => el.textContent ?? "")).split("\n").filter((l) => l.trim() !== "");
          expect(lines.length, path).toBeGreaterThan(1);
          await page.mouse.move(2, 2);
          await expect(tip.isVisible(), path).resolves.toBe(false);
        }
      });
    });

    it("Definition: a hover over a signal label shows div.tooltip with the definition, and Tab to the label shows it too", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath());
        const label = page.locator("[data-definition]").first();
        const text = (await label.getAttribute("data-definition")) ?? "";
        expect(text).not.toBe("");
        const tip = page.locator("div.tooltip");
        await label.hover();
        await expect(tip.isVisible()).resolves.toBe(true);
        expect(await tip.evaluate((el) => el.textContent)).toBe(text);
        await page.mouse.move(2, 2);
        await expect(tip.isVisible()).resolves.toBe(false);
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press("Tab");
          if (await page.evaluate(() => document.activeElement?.hasAttribute("data-definition") ?? false)) break;
        }
        await expect(tip.isVisible()).resolves.toBe(true);
        expect(await tip.evaluate((el) => el.textContent)).toBe(text);
        expect(await tip.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(360);
      });
    });

    it(
      "Refresh: a typed character in the Requests text field survives the 15 s refresh",
      async () => {
        await withPage(async (page) => {
          await page.goto(wikiPath("/requests?status=queued"));
          expect(await page.locator("main").getAttribute("data-refresh")).not.toBeNull();
          await page.locator("input[name=q]").pressSequentially("x");
          await page.waitForTimeout(REFRESH_WAIT_MS);
          expect(await page.locator("input[name=q]").inputValue()).toBe("x");
        });
      },
      TEST_TIMEOUT_MS,
    );

    it("Focus ring: Tab lands on the brand link, then the wiki switcher, each with a visible outline", async () => {
      await withPage(async (page) => {
        await page.goto(wikiPath());
        await page.keyboard.press("Tab");
        const brand = await focused(page);
        expect(brand.tag).toBe("A");
        expect(brand.cls).toContain("brand");
        const brandOutline = await page.evaluate(
          () => getComputedStyle(document.activeElement ?? document.body).outlineStyle,
        );
        expect(brandOutline).not.toBe("none");

        await page.keyboard.press("Tab");
        const switcher = await page.evaluate(() => ({
          tag: document.activeElement?.tagName ?? "",
          wiki: document.activeElement?.closest("details.menu.wiki") != null,
          outline: getComputedStyle(document.activeElement ?? document.body).outlineStyle,
        }));
        expect(switcher.tag).toBe("SUMMARY");
        expect(switcher.wiki).toBe(true);
        expect(switcher.outline).not.toBe("none");
      });
    });
  },
);
