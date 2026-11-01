import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleErrorKind } from "../../domain/enums.js";
import { countRetrievals, seedChange } from "../../store/index.js";
import { DAY, T0, accepted, draft } from "../../../__tests__/helpers/store.js";
import { SAMPLE_SIZE, searchPage } from "../pages/search.js";
import { parse, type Page } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let wiki: TmpWiki;
beforeEach(() => {
  wiki = openTmpWiki();
});
afterEach(() => wiki.close());

// Creeper damage with 2 versions (10, then 12); Zombie health deleted.
async function seedSearch(): Promise<{ creeper: string; zombie: string; oldSeq: number }> {
  const c = await seedChange(
    wiki.store,
    accepted([draft({ header: "Creeper damage", content: "Creepers do 10 damage." })]),
    { now: T0 },
  );
  const creeper = c.factIds[0] ?? "";
  await seedChange(
    wiki.store,
    accepted([draft({ factId: creeper, header: "Creeper damage", content: "Creepers do 12 damage." })]),
    { now: T0 + DAY },
  );
  const z = await seedChange(
    wiki.store,
    accepted([draft({ header: "Zombie health", content: "Zombies have 20 health." })]),
    { now: T0 + 2 * DAY },
  );
  const zombie = z.factIds[0] ?? "";
  await seedChange(
    wiki.store,
    accepted([{ factId: zombie, header: "", content: "", justification: "gone", references: [], isDeleted: true }]),
    { now: T0 + 3 * DAY },
  );
  return { creeper, zombie, oldSeq: c.seq };
}

async function open(query = ""): Promise<Page> {
  return parse(await searchPage(wiki.ctx({}, query)));
}

const factPath = (id: string): string => `/console/w/alpha/facts/${id}`;

describe("searchPage", () => {
  it("shows the box, the sample link, the history checkbox and says which search it is", async () => {
    const page = await open();
    expect(page.title).toBe("Search - alpha - WikiFact");
    expect(page.field("q")?.type).toBe("search");
    expect(page.buttons()).toContain("Search");
    expect(page.href("Random sample")).toBe("?sample=1");
    expect(page.field("history")).toMatchObject({ type: "checkbox", value: "1", checked: false });
    expect(page.labelOf("history")).toBe("Include old and deleted versions");
    expect(page.text).toContain("Live facts only.");
    expect(page.text).toContain("Nothing is recorded.");
    expect(page.results()).toEqual([]);
  });

  it("answers a query with the content in full and the confidence of the current version", async () => {
    const { creeper, zombie } = await seedSearch();
    const page = await open("q=creepers+do+12+damage");
    expect(page.text).toMatch(/\d+ facts\. Live facts only\. Nothing is recorded\./);
    const result = page.result("Creeper damage");
    expect(result?.href("Creeper damage")).toBe(factPath(creeper));
    expect(result?.text).toContain("Creepers do 12 damage.");
    expect(result?.text).not.toContain("Creepers do 10 damage.");
    expect(result?.text).toMatch(/\d\.\d\d/);
    expect(page.links().map((l) => l.href)).not.toContain(factPath(zombie));
    expect(page.field("q")?.value).toBe("creepers do 12 damage");
    expect(countRetrievals(wiki.store)).toBe(0);
  });

  it("shows no result and a zero count when no fact matches", async () => {
    await seedSearch();
    const page = await open("q=quantum+lattice+chromodynamics");
    expect(page.results()).toEqual([]);
    expect(page.text).toContain("0 facts.");
  });

  it("runs the agent search with history: a deleted fact and an old version are marked, with the matched content", async () => {
    const { creeper, zombie, oldSeq } = await seedSearch();
    const deleted = await open("q=zombies+have+20+health&history=1");
    expect(deleted.text).toContain("All versions, deleted facts too.");
    const zombieResult = deleted.result("Zombie health");
    expect(zombieResult?.href("Zombie health")).toBe(factPath(zombie));
    expect(zombieResult?.text).toContain("deleted");
    expect(zombieResult?.text).toContain("Zombies have 20 health.");
    const old = await open("q=creepers+do+10+damage&history=1");
    const oldResult = old.result("Creeper damage");
    expect(oldResult?.href("Creeper damage")).toBe(factPath(creeper));
    expect(oldResult?.text).toContain("old version");
    // The seq is in the title of the marker only.
    expect(oldResult?.text).not.toContain("seq");
    expect(oldResult?.$(".marker")?.getAttribute("title")).toBe(`seq ${oldSeq}`);
    expect(oldResult?.text).toContain("Creepers do 10 damage.");
    expect(old.field("history")?.checked).toBe(true);
    expect(countRetrievals(wiki.store)).toBe(0);
  });

  it("has no ranking view: the explain parameter changes nothing", async () => {
    await seedSearch();
    const query = "q=how+much+damage+do+creepers+do";
    const plain = await open(query);
    const asked = await open(`${query}&explain=1`);
    expect(asked.text).toBe(plain.text);
    expect(asked.folds().map((f) => f.summary)).not.toContain("Ranking");
    expect(asked.kv()).toEqual({});
    expect(asked.field("explain")).toBeUndefined();
  });

  it("shows the sample size of random live facts with the content, a fresh set, without a query", async () => {
    const facts = Array.from({ length: 15 }, (_, i) =>
      draft({ header: `Sample fact ${i}`, content: `Sample content ${i}.` }),
    );
    await seedChange(wiki.store, accepted(facts), { now: T0 });
    const page = await open("sample=1");
    const shown = new Set(page.results().map((r) => /Sample content \d+\./.exec(r.text)?.[0]));
    expect(page.results()).toHaveLength(SAMPLE_SIZE);
    expect(shown.size).toBe(SAMPLE_SIZE);
    expect(shown.has(undefined)).toBe(false);
    expect(page.text).toMatch(new RegExp(`\\b${SAMPLE_SIZE} random\\b`));
    expect(countRetrievals(wiki.store)).toBe(0);
  });

  it("samples only live facts", async () => {
    const { creeper, zombie } = await seedSearch();
    const page = await open("sample=1");
    expect(page.results()).toHaveLength(1);
    expect(page.results()[0]?.href("Creeper damage")).toBe(factPath(creeper));
    expect(page.links().map((l) => l.href)).not.toContain(factPath(zombie));
  });

  it("is 400 for a query over the embedding window", async () => {
    const long = Array.from({ length: 700 }, (_, i) => `word${i}`).join("+");
    await expect(searchPage(wiki.ctx({}, `q=${long}`))).rejects.toMatchObject({ kind: ConsoleErrorKind.BadQuery });
  });
});
