// The config form against a real registry: it edits the file as it is, so a preset keeps its role (technical/console.md, "Direct edits of non-request fields").
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config/index.js";
import { Effort, Mode, Quality, QuestionId } from "../../domain/enums.js";
import { WIKI_CONFIG_FILE } from "../../paths.js";
import { createWikiRegistry, type WikiRegistry } from "../../service/registry.js";
import { registryDeps } from "../deps.js";
import { parse } from "./helpers/dom.js";
import { post, serveConsole, type RunningConsole } from "./helpers/serve.js";

let dir: string;
let registry: WikiRegistry;
let server: RunningConsole;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-settings-file-"));
  registry = createWikiRegistry({
    wikisDir: dir,
    host: "127.0.0.1",
    withWorker: false,
    log: () => undefined,
    baseUrl: () => "http://127.0.0.1:7777",
  });
  registry.addWiki("alpha", "A subject.", Quality.Budget);
  server = await serveConsole(registryDeps(registry, () => undefined));
});
afterEach(async () => {
  await server.close();
  registry.stop();
});

const fileOf = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, "alpha", WIKI_CONFIG_FILE), "utf8")) as Record<string, unknown>;

describe("the config form on a real wiki", () => {
  it("shows the file's keys, an empty field for every key it lacks and no preset question", async () => {
    const page = parse(await (await fetch(`${server.base}/console/w/alpha/settings`)).text());
    expect(page.field("subject")?.value).toBe("A subject.");
    expect(page.field("quality")?.value).toBe("budget");
    expect(page.field("searchCap")?.value).toBe("");
    expect(page.field("questions")).toMatchObject({ type: "textarea", value: "" });
  });

  it("writes one question override and nothing else; the quality still reaches the other questions", async () => {
    const override = { model: "override-model", effort: Effort.High };
    const form = await (async () => {
      const page = parse(await (await fetch(`${server.base}/console/w/alpha/settings`)).text());
      // The fields a browser would send: every text key of the config form as shown.
      const fields: Record<string, string> = { confirm: "1" };
      for (const f of page.formTo("/console/w/alpha/settings/config")?.fields ?? [])
        if (f.type === "text") fields[f.name] = f.value;
      return fields;
    })();
    const done = await post(server.base, "/console/w/alpha/settings/config", {
      ...form,
      questions: JSON.stringify({ [QuestionId.Q2]: override }),
    });
    expect(done.status).toBe(303);
    expect(fileOf()).toEqual({
      mode: Mode.Local,
      subject: "A subject.",
      quality: Quality.Budget,
      questions: { [QuestionId.Q2]: override },
    });
    const preset = parseConfig({ mode: Mode.Local, subject: "A subject.", quality: Quality.Budget }).questions;
    const now = registry.get("alpha")?.config.questions;
    expect(now?.[QuestionId.Q2]).toEqual(override);
    expect(now?.[QuestionId.Q1]).toEqual(preset[QuestionId.Q1]);
    expect(now?.[QuestionId.Q4]).toEqual(preset[QuestionId.Q4]);
  });
});
