// Takes the screenshots of the operator console (technical/console.md, "Pages", "Code layout and build" and "Browser test") through playwright-core on the Edge
// or Chrome of the machine, so a visual change comes with the pictures that prove it.
//
//   npm run console:shots -- [--base http://127.0.0.1:7777] [--out reports/console-shots] [--browser <path>]
//
// One full-page PNG per page at 1440 px wide in the light scheme (`<name>.png`) and the dark scheme (`<name>-dark.png`),
// and the state shots in the light scheme, each the viewport only: `menu-wiki.png`, `menu-more.png`, `dialog.png` (the
// "Run now" dialog of Jobs; skipped and named when the console may not write) and `tooltip.png` (the pointer over a
// slot of the stage chart). The browser is `--browser`, else the `msedge` channel, else the `chrome` channel. The first
// wiki, a fact and a request are found in the HTML of the running console. A page whose object the
// wiki does not have yet is skipped and named. The list of the files written goes to stdout.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

/** The viewport width of every screenshot, in px. */
const WIDTH = 1440;
/** The viewport height of every screenshot, in px. */
const HEIGHT = 900;
/** How long one browser action may take, in ms. */
const ACTION_TIMEOUT_MS = 30_000;
/** A ULID, the id of a fact and a request. */
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
/** The browser channels tried in order when `--browser` is absent. */
const CHANNELS = ["msedge", "chrome"];
/** The color schemes, with the suffix of the file name. */
const SCHEMES = [
  { scheme: "light", suffix: "" },
  { scheme: "dark", suffix: "-dark" },
];

function parseArgs(argv) {
  const opts = { base: "http://127.0.0.1:7777", out: "reports/console-shots", browser: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base" || arg === "--out" || arg === "--browser") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
    } else throw new Error(`unknown argument ${arg}; use --base, --out and --browser`);
  }
  return opts;
}

async function pageText(base, path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.text();
}

function firstMatch(text, pattern) {
  return new RegExp(pattern).exec(text)?.[1];
}

// The pages of technical/console.md, "Pages" for a running console, with the objects found in its HTML.
async function discover(base) {
  const home = await pageText(base, "/console/");
  const wiki = firstMatch(home, '/console/w/([^/"?#]+)');
  if (wiki === undefined) throw new Error("the console lists no wiki; create one first");
  const root = `/console/w/${wiki}`;
  // The console lists no facts: the random sample links them.
  const [sample, requests] = await Promise.all([
    pageText(base, `${root}/search?sample=1`),
    pageText(base, `${root}/requests`),
  ]);
  const fact = firstMatch(sample, `/facts/(${ULID})`);
  const request = firstMatch(requests, `/requests/(${ULID})`);
  return {
    root,
    pages: [
      { name: "wikis", path: "/console/" },
      { name: "overview", path: root },
      { name: "overview-all", path: `${root}?span=all` },
      { name: "health", path: `${root}/health` },
      { name: "jobs", path: `${root}/jobs` },
      { name: "search", path: `${root}/search?q=worker` },
      { name: "search-sample", path: `${root}/search?sample=1` },
      { name: "fact", path: fact && `${root}/facts/${fact}` },
      { name: "requests", path: `${root}/requests` },
      { name: "request", path: request && `${root}/requests/${request}` },
      { name: "settings", path: `${root}/settings` },
    ],
  };
}

// Launches the browser at `--browser`, else the first channel that starts.
async function launch(executable) {
  if (executable !== undefined) return chromium.launch({ executablePath: executable });
  const failures = [];
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ channel });
    } catch (e) {
      failures.push(`${channel}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
  throw new Error(
    `no Edge or Chrome could be launched (${failures.join("; ")}); pass --browser <path to the executable>`,
  );
}

// The full-page shot of every page in one color scheme; returns the files written.
async function pageShots(browser, opts, pages, { scheme, suffix }) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const files = [];
  try {
    const page = await context.newPage();
    for (const p of pages) {
      if (p.path === undefined) {
        if (scheme === "light") console.error(`skipped ${p.name}: the wiki has no such object yet`);
        continue;
      }
      await page.goto(`${opts.base}${p.path}`, { waitUntil: "networkidle" });
      const file = resolve(opts.out, `${p.name}${suffix}.png`);
      await page.screenshot({ path: file, fullPage: true });
      files.push(file);
    }
  } finally {
    await context.close();
  }
  return files;
}

// The state shots in the light scheme, each the viewport only; returns the files written.
async function stateShots(browser, opts, found) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: "light" });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const files = [];
  const shot = async (page, name) => {
    const file = resolve(opts.out, `${name}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  };
  try {
    const page = await context.newPage();
    await page.goto(`${opts.base}${found.root}`, { waitUntil: "networkidle" });
    await page.locator("details.menu.wiki > summary").click();
    await shot(page, "menu-wiki");
    await page.keyboard.press("Escape");
    await page.locator("details.menu.more > summary").click();
    await shot(page, "menu-more");
    await page.keyboard.press("Escape");

    await page.goto(`${opts.base}${found.root}/jobs`, { waitUntil: "networkidle" });
    const runNow = page.locator("button[data-dialog]", { hasText: "Run now" }).first();
    if ((await runNow.count()) === 0) console.error("skipped dialog: the console may not write");
    else {
      await runNow.click();
      await shot(page, "dialog");
      await page.keyboard.press("Escape");
    }

    await page.goto(`${opts.base}${found.root}`, { waitUntil: "networkidle" });
    const slot = page.locator("g.slot rect.hit").first();
    if ((await slot.count()) === 0) console.error("skipped tooltip: the stage chart has no group yet");
    else {
      await slot.hover({ force: true });
      await page.locator("div.tooltip").waitFor({ state: "visible" });
      await shot(page, "tooltip");
    }
  } finally {
    await context.close();
  }
  return files;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const found = await discover(opts.base);
  mkdirSync(opts.out, { recursive: true });
  const browser = await launch(opts.browser);
  const files = [];
  try {
    for (const scheme of SCHEMES) files.push(...(await pageShots(browser, opts, found.pages, scheme)));
    files.push(...(await stateShots(browser, opts, found)));
  } finally {
    await browser.close();
  }
  for (const f of files) console.log(f);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
