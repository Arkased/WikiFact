import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleErrorKind, Mode, RetrievalKind } from "../../domain/enums.js";
import { recordRetrieval, seedChange } from "../../store/index.js";
import { DAY, T0, accepted, draft } from "../../../__tests__/helpers/store.js";
import { factPage } from "../pages/fact.js";
import { parse } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";

let wiki: TmpWiki;
beforeEach(() => {
  wiki = openTmpWiki();
});
afterEach(() => wiki.close());

// Alpha with 3 versions: created, corrected with a reference, then deleted.
async function seedAlpha(): Promise<{ alpha: string; ref: string; seqs: number[]; requests: string[] }> {
  const r = await seedChange(wiki.store, accepted([draft({ header: "Ref", content: "A reference." })]), { now: T0 });
  const ref = r.factIds[0] ?? "";
  const v1 = await seedChange(wiki.store, accepted([draft({ header: "Alpha", content: "Creepers do 10 damage." })]), {
    now: T0 + DAY,
  });
  const alpha = v1.factIds[0] ?? "";
  const v2 = await seedChange(
    wiki.store,
    accepted([
      draft({
        factId: alpha,
        header: "Alpha",
        content: "Creepers do 12 damage.",
        justification: "I measured 12.",
        references: [ref],
      }),
    ]),
    { now: T0 + 2 * DAY },
  );
  const v3 = await seedChange(
    wiki.store,
    accepted([{ factId: alpha, header: "", content: "", justification: "gone", references: [], isDeleted: true }]),
    { now: T0 + 3 * DAY },
  );
  return { alpha, ref, seqs: [v1.seq, v2.seq, v3.seq], requests: [v1.requestId, v2.requestId, v3.requestId] };
}

// A 4th version that revives Alpha with new content, and a justification.
async function reviveAlpha(alpha: string): Promise<number> {
  const v4 = await seedChange(
    wiki.store,
    accepted([
      draft({
        factId: alpha,
        header: "Alpha",
        content: "Creepers do 14 damage.",
        justification: "I measured 14.",
      }),
    ]),
    { now: T0 + 4 * DAY },
  );
  return v4.seq;
}

// A 4th version with the same content and no justification, as the pipeline derives it.
async function deriveAlpha(alpha: string): Promise<void> {
  await seedChange(
    wiki.store,
    accepted([
      {
        factId: alpha,
        header: "Alpha",
        content: "Creepers do 12 damage.",
        justification: "",
        references: [],
      },
    ]),
    { now: T0 + 4 * DAY },
  );
}

describe("factPage fact block", () => {
  it("shows the header, the content, the justification as stored and the reasoning", async () => {
    const { alpha } = await seedAlpha();
    await reviveAlpha(alpha);
    const page = parse(await factPage(wiki.ctx({ id: alpha })));
    expect(page.title).toBe("Alpha - alpha - WikiFact");
    expect(page.headings("h1")).toEqual(["Alpha"]);
    const fact = page.section("Fact");
    expect(fact?.text).toContain("Creepers do 14 damage.");
    expect(fact?.text).toContain("Justification");
    expect(fact?.text).toContain("I measured 14.");
    expect(fact?.text).toContain("Why this version");
    expect(fact?.text).toContain("test reasoning");
    expect(page.text).not.toContain("This fact is deleted.");
  });

  it("says the pipeline derived a version with an empty justification", async () => {
    const { alpha } = await seedAlpha();
    await deriveAlpha(alpha);
    const fact = parse(await factPage(wiki.ctx({ id: alpha }))).section("Fact");
    expect(fact?.text).toContain("pipeline derived");
    expect(fact?.text).not.toContain("Justification");
  });

  it("shows a deleted fact with a deleted notice", async () => {
    const { alpha } = await seedAlpha();
    const page = parse(await factPage(wiki.ctx({ id: alpha })));
    expect(page.text).toContain("This fact is deleted.");
  });
});

describe("factPage history", () => {
  it("lists the versions newest first, each linking its request by its time, with its seq in the title only", async () => {
    const { alpha, seqs, requests } = await seedAlpha();
    const history = parse(await factPage(wiki.ctx({ id: alpha }))).section("History");
    const links = history?.links().filter((l) => l.href.includes("/requests/"));
    expect(links?.map((l) => l.href)).toEqual([...requests].reverse().map((id) => `/console/w/alpha/requests/${id}`));
    for (const link of links ?? []) expect(link.text).toMatch(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d$/);
    expect(history?.$$("a[href*='/requests/']").map((a) => a.getAttribute("title"))).toEqual(
      [...seqs].reverse().map((s) => `seq ${s}`),
    );
    expect(history?.text).not.toContain("seq");
    // The console has no change page: no history entry links to one.
    expect(history?.links().filter((l) => l.href.includes("/changes/"))).toEqual([]);
    expect(history?.folds().map((f) => f.summary)).toContain("Diff and reasoning");
  });

  it("marks only the entry of the current version as current", async () => {
    const { alpha, requests } = await seedAlpha();
    const page = parse(await factPage(wiki.ctx({ id: alpha })));
    const current = page.section("History")?.current() ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]?.linkTo(`/requests/${requests[2]}`)).toBeDefined();
  });

  it("shows the Fact and History panels and the Details panel, and no chart of the reads", async () => {
    const { alpha } = await seedAlpha();
    await reviveAlpha(alpha);
    recordRetrieval(wiki.store, alpha, { now: Date.now() });
    const page = parse(await factPage(wiki.ctx({ id: alpha })));
    expect(page.headings()).toEqual(expect.arrayContaining(["Fact", "History", "Details"]));
    expect(page.headings()).not.toContain("Reads, 30 days");
    expect(page.svgs()).toEqual([]);
    expect(page.section("Details")?.kvValue("Status")).toBe("live");
    expect(page.section("History")?.kvValue("Status")).toBeUndefined();
  });

  it("shows the content diff, the reference edits and the reasoning of each version", async () => {
    const { alpha, ref } = await seedAlpha();
    const history = parse(await factPage(wiki.ctx({ id: alpha }))).section("History");
    expect(history?.removed()).toEqual(expect.arrayContaining(["10"]));
    expect(history?.inserted()).toEqual(expect.arrayContaining(["12", ref]));
    expect(history?.href(ref)).toBe(`/console/w/alpha/facts/${ref}`);
    expect(history?.text).toContain("I measured 12.");
    expect(history?.text).toContain("test reasoning");
  });

  it("marks the deletion, the observed version, the revival and the derived version", async () => {
    const { alpha, requests } = await seedAlpha();
    const deleted = parse(await factPage(wiki.ctx({ id: alpha }))).section("History");
    expect(deleted?.itemWith(`/requests/${requests[2]}`)?.text).toContain("deletion");
    expect(deleted?.text).toContain("observed");
    await deriveAlpha(alpha);
    const revived = parse(await factPage(wiki.ctx({ id: alpha }))).section("History");
    expect(revived?.text).toContain("revival");
    expect(revived?.text).toContain("derived");
  });
});

describe("factPage details and reads", () => {
  it("shows the status, the origin, the id, the references with their state and the dependents", async () => {
    const { alpha, ref } = await seedAlpha();
    await reviveAlpha(alpha);
    await seedChange(
      wiki.store,
      accepted([
        draft({
          factId: alpha,
          header: "Alpha",
          content: "Creepers do 14 damage.",
          justification: "I measured 14.",
          references: [ref],
        }),
      ]),
      { now: T0 + 5 * DAY },
    );
    const details = parse(await factPage(wiki.ctx({ id: alpha }))).section("Details");
    expect(details?.kvValue("Status")).toBe("live");
    expect(details?.kvValue("Origin")).toBe("observed");
    expect(details?.kvValue("Id")).toBe(alpha);
    expect(details?.kvView("References")?.href("Ref")).toBe(`/console/w/alpha/facts/${ref}`);
    const refDetails = parse(await factPage(wiki.ctx({ id: ref }))).section("Details");
    expect(refDetails?.kvView("Dependents")?.href("Alpha")).toBe(`/console/w/alpha/facts/${alpha}`);
    expect(refDetails?.kvValue("References")).toBe("none");
  });

  it("counts the reads and the confirms of the current version", async () => {
    const { alpha } = await seedAlpha();
    await reviveAlpha(alpha);
    recordRetrieval(wiki.store, alpha, { now: Date.now() });
    recordRetrieval(wiki.store, alpha, { now: Date.now(), kind: RetrievalKind.Confirm });
    const page = parse(await factPage(wiki.ctx({ id: alpha })));
    expect(page.section("Details")?.kvValue("Reads and confirms")).toBe("1 read, 1 confirm");
  });
});

describe("factPage controls", () => {
  it("has no button and no form, in local mode and in deployed mode: the console edits no fact", async () => {
    const { alpha } = await seedAlpha();
    await reviveAlpha(alpha);
    const local = parse(await factPage(wiki.ctx({ id: alpha })));
    expect(local.within("main")?.buttons()).toEqual([]);
    expect(local.forms().filter((f) => f.method === "post")).toEqual([]);
    const deployed = openTmpWiki("alpha", { mode: Mode.Deployed });
    try {
      const r = await seedChange(deployed.store, accepted([draft({ header: "Solo", content: "Solo." })]), { now: T0 });
      const page = parse(await factPage(deployed.ctx({ id: r.factIds[0] ?? "" })));
      expect(page.title).toBe("Solo - alpha - WikiFact");
      expect(page.forms().filter((f) => f.method === "post")).toEqual([]);
      expect(page.within("main")?.buttons()).toEqual([]);
    } finally {
      deployed.close();
    }
  });

  it("is 404 for an unknown fact", async () => {
    await expect(factPage(wiki.ctx({ id: "nope" }))).rejects.toMatchObject({ kind: ConsoleErrorKind.NotFound });
  });
});
