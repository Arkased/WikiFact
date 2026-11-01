import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseConfig } from "../../config/index.js";
import { Mode } from "../../domain/enums.js";
import { startHttpServer, type HttpHandle } from "../../mcp/http.js";
import { WIKI_CONFIG_FILE, WIKI_DB_FILE } from "../../paths.js";
import { createWikiRegistry, discoverWikis, type WikiRegistry } from "../../service/registry.js";
import { closeStore, openStoreFor, seedChange } from "../../store/index.js";
import { T0, accepted, draft, write } from "../../../__tests__/helpers/store.js";
import { registryDeps } from "../deps.js";
import { ConsoleError } from "../errors.js";
import { exportPage } from "../pages/export.js";
import { consoleRoute } from "../routes.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

describe("exportPage", () => {
  let w: TmpWiki;
  beforeEach(() => {
    w = openTmpWiki();
  });
  afterEach(() => w.close());

  async function seed(): Promise<{ live: string; deleted: string }> {
    const s = await seedChange(
      w.store,
      accepted([
        draft({ header: "Zebra", content: "Zebras have stripes." }),
        draft({ header: "Apple", content: "Apples are fruit." }),
        draft({ header: "Gone", content: "Gone content." }),
      ]),
      { now: T0 },
    );
    const [live = "", , deleted = ""] = s.factIds;
    await seedChange(
      w.store,
      accepted([
        {
          factId: deleted,
          header: "",
          content: "",
          justification: "gone",
          references: [],
          isDeleted: true,
        },
      ]),
      { now: T0 + 1 },
    );
    return { live, deleted };
  }

  it("returns an empty JSON file on an empty wiki", async () => {
    const file = await exportPage(w.ctx());
    expect(file).toMatchObject({ contentType: "application/json; charset=utf-8", fileName: "alpha-facts.json" });
    expect(JSON.parse(file.body)).toMatchObject({ wiki: "alpha", facts: [] });
  });

  it("exports the live facts as JSON with their version and confidence; deleted on request", async () => {
    const s = await seed();
    const file = await exportPage(w.ctx());
    const doc = JSON.parse(file.body) as { facts: Record<string, unknown>[] };
    expect(doc.facts.map((f) => f.header)).toEqual(["Apple", "Zebra"]);
    const zebra = doc.facts[1];
    expect(zebra).toMatchObject({ id: s.live, content: "Zebras have stripes.", isDeleted: false, versions: 1 });
    expect(typeof zebra?.confidence).toBe("number");
    const all = JSON.parse((await exportPage(w.ctx({}, "deleted=1"))).body) as { facts: Record<string, unknown>[] };
    expect(all.facts.map((f) => f.header)).toEqual(["Apple", "Gone", "Zebra"]);
    expect(all.facts[1]).toMatchObject({ id: s.deleted, isDeleted: true });
  });

  it("exports Markdown as one list of facts sorted by header, with no group", async () => {
    await seed();
    const file = await exportPage(w.ctx({}, "format=md&deleted=1"));
    expect(file).toMatchObject({ contentType: "text/markdown; charset=utf-8", fileName: "alpha-facts.md" });
    const lines = file.body.split("\n");
    expect(lines[0]).toBe("# alpha: facts");
    expect(lines.filter((l) => l.startsWith("## "))).toEqual([]);
    const items = lines.filter((l) => l.startsWith("- "));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^- \*\*Apple\*\* — Apples are fruit\. \(confidence \d\.\d\d\)$/);
    expect(items[1]).toMatch(/^- \*\*Gone\*\* — Gone content\. \(confidence 0\.00, deleted\)$/);
    expect(items[2]).toMatch(/^- \*\*Zebra\*\* — Zebras have stripes\. \(confidence \d\.\d\d\)$/);
  });

  it("rejects a bad format and an unknown wiki", async () => {
    await expect(exportPage(w.ctx({}, "format=xml"))).rejects.toBeInstanceOf(ZodError);
    await expect(exportPage(w.ctx({ w: "nope" }))).rejects.toBeInstanceOf(ConsoleError);
  });
});

describe("the export route over HTTP", () => {
  let dir: string;
  let registry: WikiRegistry;
  let handle: HttpHandle;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wikifact-export-"));
    const folder = join(dir, "alpha");
    mkdirSync(folder);
    const raw = { mode: Mode.Local, subject: "The wiki." };
    writeFileSync(join(folder, WIKI_CONFIG_FILE), JSON.stringify(raw));
    const store = openStoreFor(parseConfig(raw), join(folder, WIKI_DB_FILE));
    write(store, accepted([draft({ header: "Creeper damage" })]), T0);
    closeStore(store);
    registry = createWikiRegistry({
      wikisDir: dir,
      host: "127.0.0.1",
      withWorker: false,
      log: () => undefined,
      baseUrl: () => base,
    });
    for (const wiki of discoverWikis(dir)) registry.mount(wiki);
    const log = (): void => undefined;
    handle = await startHttpServer(consoleRoute(registryDeps(registry, log)), { host: "127.0.0.1", port: 0, log });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await new Promise((r) => handle.server.close(r));
    registry.stop();
  });

  it("sends the file with its content type and disposition", async () => {
    const res = await fetch(`${base}/console/w/alpha/facts/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="alpha-facts.md"');
    const text = await res.text();
    expect(text).not.toContain("## ");
    expect(text).toContain("- **Creeper damage** — Creepers do 10 damage.");
    expect(text).not.toContain("<html");
    const json = await fetch(`${base}/console/w/alpha/facts/export`);
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json.headers.get("content-disposition")).toBe('attachment; filename="alpha-facts.json"');
    expect((JSON.parse(await json.text()) as { facts: unknown[] }).facts).toHaveLength(1);
  });

  it("still answers a bad query with an HTML error page", async () => {
    const res = await fetch(`${base}/console/w/alpha/facts/export?format=xml`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
