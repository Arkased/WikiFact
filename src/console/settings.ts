// technical/console.md, "Direct edits of non-request fields": the direct edits of a wiki, through the registry: the description, the config keys of
// `CONFIG_EDIT_KEYS`, and the name. None touches a table the worker reads (design/console.md, "The rule that splits the edits").
import { z } from "zod";
import { ConfigEditKey, ConsoleAction, ConsoleErrorKind, ConsoleSection } from "../domain/enums.js";
// Not the service index: it imports the console route, and `configFields` below needs the keys at load time.
import { CONFIG_EDIT_KEYS } from "../service/edit.js";
import { ConsoleError } from "./errors.js";
import { html, wikiPath, type SafeHtml } from "./html.js";
import { defineWrite, needWiki, refusing, type WriteRoute } from "./write.js";

// The keys whose value is a number; the keys `questions` and `weights` are JSON; the others are text.
const NUMBER_KEYS: ReadonlySet<ConfigEditKey> = new Set([
  ConfigEditKey.SearchCap,
  ConfigEditKey.AgentSearchCap,
  ConfigEditKey.RelevanceFloor,
  ConfigEditKey.QuestionTimeout,
]);
const JSON_KEYS: ReadonlySet<ConfigEditKey> = new Set([ConfigEditKey.Questions, ConfigEditKey.Weights]);

/**
 * Tells whether the config form edits a key as JSON text.
 *
 * @param key - a key of the config form
 * @returns true for `questions` and `weights`
 * @sideEffects none
 */
export function isJsonKey(key: ConfigEditKey): boolean {
  return JSON_KEYS.has(key);
}

/**
 * Writes the value a key has in `wikifact.json` as the form shows it.
 *
 * @param raw - the keys of the file as it is, from `readRawConfig`: no preset and no default merged in
 * @param key - the name of a key in the file
 * @returns the text of a string or number, the compact JSON of an object, and `""` for a key the file lacks, so
 *   that an absent key shows as an empty field
 * @sideEffects none
 */
export function configText(raw: Readonly<Record<string, unknown>>, key: string): string {
  const value = raw[key];
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

// The value a form text stands for: a number, parsed JSON, or the text itself.
function parseValue(key: ConfigEditKey, text: string): unknown {
  if (NUMBER_KEYS.has(key)) {
    const n = Number(text);
    if (Number.isNaN(n)) throw new ConsoleError(ConsoleErrorKind.BadQuery, `${key}: "${text}" is not a number`);
    return n;
  }
  if (!JSON_KEYS.has(key)) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleError(ConsoleErrorKind.BadQuery, `${key}: the text is not valid JSON`);
  }
}

/** The keys a config form changes and the lines that say each change. */
interface ConfigPlan {
  /** The key to the new value; `undefined` removes the key (the default applies). */
  patch: Record<string, unknown>;
  lines: SafeHtml[];
}

/**
 * Compares a submitted config form with the file as it is, so that a key the operator did not touch is not written,
 * and an absent key stays absent while its field is empty.
 *
 * @param raw - the keys of `wikifact.json` as the file holds them, from `readRawConfig`
 * @param form - the field texts by key; a key absent from the form is not touched
 * @returns the patch for `updateConfig` and a line per changed key
 * @throws {ConsoleError} `BadQuery` for a number or JSON text that does not parse; `Refused` when nothing changed
 * @sideEffects none
 */
export function planConfig(
  raw: Readonly<Record<string, unknown>>,
  form: Record<string, string | undefined>,
): ConfigPlan {
  const patch: Record<string, unknown> = {};
  const lines: SafeHtml[] = [];
  for (const key of CONFIG_EDIT_KEYS) {
    const text = form[key]?.trim();
    const was = configText(raw, key);
    if (text === undefined || text === was) continue;
    patch[key] = text === "" ? undefined : parseValue(key, text);
    lines.push(
      text === ""
        ? html`<li><code>${key}</code>: removed, the default applies (was ${was})</li>`
        : html`<li><code>${key}</code>: ${was === "" ? "(unset)" : was} to ${text}</li>`,
    );
  }
  if (lines.length === 0) throw new ConsoleError(ConsoleErrorKind.Refused, "nothing to change: every key is as it was");
  return { patch, lines };
}

const configFields = z.object(Object.fromEntries(CONFIG_EDIT_KEYS.map((key) => [key, z.string().optional()])));

const describeRoute = defineWrite({
  action: ConsoleAction.SetDescription,
  title: "Set the description",
  button: "Save description",
  schema: z.object({ description: z.string() }),
  describe: (ctx, f) => {
    needWiki(ctx);
    const text = f.description.trim();
    return text === ""
      ? html`<p>Remove the description of ${ctx.params.w}.</p>`
      : html`<p>Set the description of ${ctx.params.w} to:</p>
          <pre class="text">${text}</pre>`;
  },
  run: async (ctx, f) => {
    const wiki = needWiki(ctx);
    await refusing(() => ctx.deps.writes.setDescription(wiki.name, f.description));
    return { location: wikiPath(wiki.name, ConsoleSection.Settings) };
  },
  back: (ctx) => wikiPath(ctx.params.w ?? "", ConsoleSection.Settings),
});

const configRoute = defineWrite({
  action: ConsoleAction.UpdateConfig,
  title: "Edit the config",
  button: "Save config",
  schema: configFields,
  describe: (ctx, f) => {
    const wiki = needWiki(ctx);
    const { lines } = planConfig(ctx.deps.writes.readRawConfig(wiki.name), f);
    const restart =
      wiki.childRunning === undefined
        ? html`<p class="help">
            The worker runs outside this service: restart it there for the change to take effect.
          </p>`
        : html`<p>
            The worker child restarts after its current request. The MCP endpoint reads the new config at once.
          </p>`;
    return html`<p>Write these keys of wikifact.json for ${wiki.name}:</p>
      <ul>
        ${lines}
      </ul>
      ${restart}`;
  },
  run: async (ctx, f) => {
    const wiki = needWiki(ctx);
    const { patch } = planConfig(ctx.deps.writes.readRawConfig(wiki.name), f);
    await refusing(() => ctx.deps.writes.updateConfig(wiki.name, patch));
    return { location: wikiPath(wiki.name, ConsoleSection.Settings) };
  },
  back: (ctx) => wikiPath(ctx.params.w ?? "", ConsoleSection.Settings),
});

const renameRoute = defineWrite({
  action: ConsoleAction.RenameWiki,
  title: "Rename the wiki",
  button: "Rename",
  schema: z.object({ name: z.string().trim().min(1, "a name is required") }),
  describe: (ctx, f) => {
    const wiki = needWiki(ctx);
    return html`<p>
        Rename ${wiki.name} to <code>${f.name}</code>: its worker stops, its folder moves, and the wiki is mounted under
        the new name.
      </p>
      <p>
        The MCP URL changes from <code>/wikis/${wiki.name}/mcp</code> to <code>/wikis/${f.name}/mcp</code>. A session
        that pinned the old URL must add the new one.
      </p>`;
  },
  run: async (ctx, f) => {
    const wiki = needWiki(ctx);
    const renamed = await refusing(() => ctx.deps.writes.renameWiki(wiki.name, f.name));
    const settings = wikiPath(renamed.name, ConsoleSection.Settings);
    return { location: `${settings}?renamed=${encodeURIComponent(renamed.from)}`, wiki: renamed.name };
  },
  back: (ctx) => wikiPath(ctx.params.w ?? "", ConsoleSection.Settings),
});

/** The write routes of the wiki settings of technical/console.md, "Direct edits of non-request fields". */
export const SETTINGS_ROUTES: WriteRoute[] = [describeRoute, configRoute, renameRoute];
