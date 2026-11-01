import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsoleAction, LogEvent, Mode, QuestionId, ServeTarget } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { questionLabel, settingsPage } from "../pages/settings.js";
import { fakeWrites, linesOf, post, serveConsole, type FakeWrites, type RunningConsole } from "./helpers/serve.js";
import { parse, type Page } from "./helpers/dom.js";
import { openTmpWiki, type TmpWiki } from "./helpers/tmp-wiki.js";
import { configText, planConfig } from "../settings.js";

let wiki: TmpWiki;
let server: RunningConsole;
let fake: FakeWrites;
let lines: LogLine[];

beforeEach(async () => {
  fake = fakeWrites();
  lines = [];
  wiki = openTmpWiki("alpha", { writes: fake.writes, log: (l) => lines.push(l) });
  server = await serveConsole(wiki.deps);
});
afterEach(async () => {
  await server.close();
  wiki.close();
});

async function fetchPage(path: string, base = server.base): Promise<Page> {
  return parse(await (await fetch(`${base}${path}`)).text());
}

describe("planConfig", () => {
  const raw = { mode: "local", subject: "The test wiki.", questionTimeout: 90 };

  it("keeps only the keys whose text differs from the file, parsed by kind", () => {
    const { patch } = planConfig(raw, {
      subject: "The test wiki.",
      searchCap: "7",
      weights: '{"confidence":2}',
      questionTimeout: configText(raw, "questionTimeout"),
    });
    expect(patch).toEqual({ searchCap: 7, weights: { confidence: 2 } });
  });

  it("leaves a key the file lacks absent while its field is empty", () => {
    expect(configText(raw, "searchCap")).toBe("");
    expect(configText(raw, "questions")).toBe("");
    expect(() => planConfig(raw, { searchCap: "", questions: "", quality: "" })).toThrow();
  });

  it("removes a key of the file whose text is empty", () => {
    const { patch } = planConfig(raw, { questionTimeout: "" });
    expect(patch).toEqual({ questionTimeout: undefined });
    expect("questionTimeout" in patch).toBe(true);
  });

  it("refuses a form where nothing changed, a number that is not one and JSON that is not JSON", () => {
    expect(() => planConfig(raw, { subject: "The test wiki." })).toThrow();
    expect(() => planConfig(raw, { searchCap: "many" })).toThrow();
    expect(() => planConfig(raw, { weights: "{" })).toThrow();
  });
});

describe("the description", () => {
  it("previews, then sets it through the registry and redirects to the settings page", async () => {
    const path = "/console/w/alpha/settings/description";
    const preview = await post(server.base, path, { description: "  For <editors>.  ", confirm: "0" });
    expect(preview.status).toBe(200);
    expect(parse(await preview.text()).text).toContain("For <editors>.");
    expect(fake.calls).toEqual([]);
    const done = await post(server.base, path, { description: "For editors.", confirm: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/w/alpha/settings");
    expect(fake.calls).toEqual(['setDescription ["alpha","For editors."]']);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toEqual([
      expect.objectContaining({ action: ConsoleAction.SetDescription, wiki: "alpha" }),
    ]);
  });

  it("previews the removal when the text is empty", async () => {
    const path = "/console/w/alpha/settings/description";
    const empty = await post(server.base, path, { description: " ", confirm: "0" });
    expect(empty.status).toBe(200);
    const filled = await post(server.base, path, { description: "For editors.", confirm: "0" });
    const emptyText = parse(await empty.text()).text;
    expect(emptyText).not.toContain("For editors.");
    expect(emptyText).not.toBe(parse(await filled.text()).text);
    expect(fake.calls).toEqual([]);
  });
});

describe("the config", () => {
  it("writes only the changed keys and redirects to the settings page", async () => {
    const path = "/console/w/alpha/settings/config";
    const fields = { subject: wiki.wiki.config.subject, searchCap: "9", confirm: "0" };
    const preview = await post(server.base, path, fields);
    expect(preview.status).toBe(200);
    const page = parse(await preview.text());
    expect(page.text).toContain("searchCap");
    expect(page.field("searchCap")?.value).toBe("9");
    const done = await post(server.base, path, { ...fields, confirm: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/w/alpha/settings");
    expect(fake.calls).toEqual(['updateConfig ["alpha",{"searchCap":9}]']);
  });

  it("is a 409 when nothing changed or the registry refuses, and a 400 for a bad number", async () => {
    const path = "/console/w/alpha/settings/config";
    const same = { subject: wiki.wiki.config.subject, confirm: "1" };
    expect((await post(server.base, path, same)).status).toBe(409);
    expect((await post(server.base, path, { searchCap: "x", confirm: "1" })).status).toBe(400);
    fake.refuse = "wikifact.json would be invalid: searchCap: too small";
    const refused = await post(server.base, path, { searchCap: "0", confirm: "1" });
    expect(refused.status).toBe(409);
    expect(parse(await refused.text()).text).toContain("would be invalid");
  });
});

describe("the rename", () => {
  it("previews the URL change, then renames and redirects to the settings page of the new name", async () => {
    const path = "/console/w/alpha/settings/rename";
    const preview = await post(server.base, path, { name: "gamma", confirm: "0" });
    expect(preview.status).toBe(200);
    expect(parse(await preview.text()).text).toContain("/wikis/gamma/mcp");
    const done = await post(server.base, path, { name: "gamma", confirm: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/console/w/gamma/settings?renamed=alpha");
    expect(fake.calls).toEqual(['renameWiki ["alpha","gamma"]']);
    expect(linesOf(lines, LogEvent.ConsoleAction)).toEqual([
      expect.objectContaining({ action: ConsoleAction.RenameWiki, wiki: "gamma" }),
    ]);
  });

  it("is a 409 with the registry's message, and a 400 without a name", async () => {
    fake.refuse = 'a wiki named "beta" exists';
    const res = await post(server.base, "/console/w/alpha/settings/rename", { name: "beta", confirm: "1" });
    expect(res.status).toBe(409);
    expect(parse(await res.text()).text).toContain("exists");
    expect((await post(server.base, "/console/w/alpha/settings/rename", { name: " ", confirm: "1" })).status).toBe(400);
  });
});

describe("the settings page", () => {
  it("shows the resolved config and the model of each question by what it does", async () => {
    const page = await fetchPage("/console/w/alpha/settings");
    expect(page.title).toBe("Settings - alpha - WikiFact");
    // The wiki switcher names the wiki: the subject is not under the heading.
    expect(page.$("header.page p.lead")).toBeNull();
    expect(page.kvValue("Mode")).toBe("local");
    expect(page.kvValue("Quality preset")).toBe(wiki.wiki.config.quality);
    expect(page.kvValue("Subject")).toBe("The test wiki.");
    expect(page.kvValue("Question timeout")).toMatch(/^\d+ s$/);
    expect(page.kvValue("Embedding model")).toBe(wiki.wiki.config.embeddingModel);
    expect(page.kvValue("Result cap")).toBe(String(wiki.wiki.config.searchCap));
    expect(page.kvValue("Agent result cap")).toBe(String(wiki.wiki.config.agentSearchCap));
    expect(page.kvValue("Relevance floor")).toBe(String(wiki.wiki.config.relevanceFloor));
    // The weights are 1 sub-list with plain labels and units.
    expect(page.kvValue("Update weight")).toBe(String(wiki.wiki.config.weights.wUpdate));
    expect(page.kvValue("Confidence half-life")).toBe("30 days");
    expect(page.kvValue("Usefulness half-life")).toBe("30 days");
    for (const term of ["Confirm weight", "Read weight", "Use weight", "Use bound"]) {
      expect(page.kvValue(term), term).toBeDefined();
    }
    const questions = page.section("Model questions");
    const names = questions?.rows().map((r) => r[0]) ?? [];
    for (const id of Object.values(QuestionId)) expect(names).toContain(questionLabel(id));
    expect(questions?.text).not.toMatch(/\bQ\d+\b/);
  });

  it("shows the forms on load and the archive as a button that opens a form", async () => {
    const page = await fetchPage("/console/w/alpha/settings");
    expect(page.buttons()).toContain("Archive");
    expect(page.formTo("/console/w/alpha/archive")?.method).toBe("post");
    // The edit forms are on the page itself, not behind a dialog (technical/console.md, "Settings").
    for (const action of ["description", "config", "rename"]) {
      expect(page.formTo(`/console/w/alpha/settings/${action}`)?.method, action).toBe("post");
      expect(page.$(`dialog form[action="/console/w/alpha/settings/${action}"]`), action).toBeNull();
    }
    expect(page.$("dialog form[action='/console/w/alpha/archive']")).not.toBeNull();
    expect(page.formTo("/console/w/alpha/settings/description")?.fields.map((f) => f.name)).toContain("description");
    expect(page.formTo("/console/w/alpha/settings/rename")?.fields.find((f) => f.name === "name")?.value).toBe("alpha");
    expect(page.formTo("/console/w/alpha/settings/config")?.fields.map((f) => f.name)).toContain("questions");
  });

  it("offers no field for the mode and the embedding model, and 1 Edit panel with the 3 forms", async () => {
    const page = await fetchPage("/console/w/alpha/settings");
    const config = page.formTo("/console/w/alpha/settings/config");
    expect(config?.fields.map((f) => f.name)).not.toContain("mode");
    expect(config?.fields.map((f) => f.name)).not.toContain("embeddingModel");
    expect(page.field("mode")).toBeUndefined();
    expect(page.field("embeddingModel")).toBeUndefined();
    expect(page.headings()).not.toContain("Config keys");
    expect(page.text).not.toContain("not edited here");
    const edit = page.section("Edit");
    expect(edit?.text).toContain("Changes restart the worker after its current request.");
    expect(edit?.text).toContain("An empty field keeps the preset's value.");
    expect(edit?.headings("h3")).toEqual(["Description", "Config", "Name"]);
    expect(edit?.buttons()).toEqual(["Save description", "Save config", "Rename"]);
    expect(page.headings()).not.toContain("Description");
    expect(page.headings()).not.toContain("Name");
  });

  it("labels the config fields with the words of the Config panel", async () => {
    const page = await fetchPage("/console/w/alpha/settings");
    expect(page.labelOf("searchCap")).toBe("Result cap");
    expect(page.labelOf("agentSearchCap")).toBe("Agent result cap");
    expect(page.labelOf("relevanceFloor")).toBe("Relevance floor");
    expect(page.labelOf("questionTimeout")).toBe("Question timeout (s)");
    expect(page.labelOf("quality")).toBe("Quality preset");
    expect(page.labelOf("subject")).toBe("Subject");
  });

  it("shows the keys the file holds and an empty field for a key it lacks", async () => {
    fake.raw = { mode: "local", subject: "The test wiki.", searchCap: 12 };
    const page = await fetchPage("/console/w/alpha/settings");
    expect(page.field("searchCap")?.value).toBe("12");
    expect(page.field("agentSearchCap")?.value).toBe("");
    expect(page.field("questions")).toMatchObject({ type: "textarea", value: "" });
  });

  it("notes the new MCP URL after a rename", async () => {
    const page = await fetchPage("/console/w/alpha/settings?renamed=old-name");
    expect(page.text).toContain("The MCP URL changed");
    expect(page.text).toContain("/wikis/old-name/mcp");
  });

  it("shows the config only when serving one database", async () => {
    const solo = openTmpWiki("solo", { target: ServeTarget.Db });
    const soloServer = await serveConsole(solo.deps);
    try {
      const page = await fetchPage("/console/w/solo/settings", soloServer.base);
      expect(page.forms().filter((f) => f.action.startsWith("/console/w/solo/"))).toEqual([]);
      expect(page.buttons()).not.toContain("Archive");
      expect(page.kvValue("Embedding model")).toBeTruthy();
      expect(page.section("Model questions")?.rows().length).toBeGreaterThan(0);
      expect(page.text).toContain("service mode");
    } finally {
      await soloServer.close();
      solo.close();
    }
  });

  it("does not read the config file when serving one database, even if the writes would refuse", async () => {
    const refusing = fakeWrites();
    refusing.refuse = "not in service mode";
    const solo = openTmpWiki("solo", { target: ServeTarget.Db, writes: refusing.writes });
    try {
      const page = parse(await settingsPage(solo.ctx()));
      expect(page.kvValue("Embedding model")).toBeTruthy();
      expect(refusing.calls).toEqual([]);
    } finally {
      solo.close();
    }
  });

  it("shows the config only when the console's writes are off", async () => {
    const deployed = openTmpWiki("alpha", { mode: Mode.Deployed });
    try {
      const page = parse(await settingsPage(deployed.ctx()));
      expect(page.forms().filter((f) => f.method === "post")).toEqual([]);
      expect(page.buttons()).not.toContain("Archive");
      expect(page.kvValue("Embedding model")).toBeTruthy();
      expect(page.section("Model questions")?.rows().length).toBeGreaterThan(0);
    } finally {
      deployed.close();
    }
  });
});
