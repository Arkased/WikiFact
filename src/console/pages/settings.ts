// technical/console.md, "Settings": the settings page of the wiki's own fields (technical/console.md, "Direct edits of non-request fields"). The resolved config as a read-only list, the model
// and effort of each question named by what it does (design/console.md, "Plain words"), and under it the forms as panels, open on load: the
// description, the config keys as the file holds them, the two refused keys and the name; the archive is a dialog.
// When the console's writes are off, or the server serves one database and has no registry, the page shows the config
// only and says why.
import { z } from "zod";
import type { Config } from "../../config/index.js";
import {
  ConfigEditKey,
  ConsoleAction,
  ConsoleSection,
  DialogId,
  GridColumns,
  QuestionId,
  ServeTarget,
  assertNever,
  enumValues,
} from "../../domain/enums.js";
import { CONFIG_EDIT_KEYS } from "../../service/edit.js";
import { DAY_MS } from "../../store/index.js";
import { writesAllowed } from "../auth.js";
import type { ConsoleWiki } from "../deps.js";
import { html, layout, sectionLabel, table, type SafeHtml } from "../html.js";
import type { PageContext } from "../page.js";
import { configText, isJsonKey } from "../settings.js";
import { actionPath } from "../write-paths.js";
import { actionForm, inputField, textareaField } from "./forms.js";
import { dialogAction, grid, kv, notice, panel, parseQuery, withWiki, type DialogAction } from "./parts/index.js";

/** The one lead of the Edit panel. */
const EDIT_LEAD = "Changes restart the worker after its current request. An empty field keeps the preset's value.";

const settingsQuery = z.object({
  // Set by the redirect after a rename (technical/console.md, "Direct edits of non-request fields"): the old name, for the notice that the MCP URL changed.
  renamed: z.string().optional(),
});

/**
 * Names a model question by what it does (design/console.md, "Plain words"), in the words of technical/updates.md, "Pipeline".
 *
 * @param id - the question
 * @returns the step's name as a maintainer reads it
 * @sideEffects none
 */
export function questionLabel(id: QuestionId): string {
  switch (id) {
    case QuestionId.Q1:
      return "the scope match";
    case QuestionId.Q2:
      return "the merge judgment (which content stands)";
    case QuestionId.Q3:
      return "the merged version draft";
    case QuestionId.Q4:
      return "the claim judgment";
    case QuestionId.Q5:
      return "the fact draft";
    case QuestionId.Q6:
      return "the narrowed fact draft";
    case QuestionId.Q7:
      return "the submission check";
    case QuestionId.Q8:
      return "the dependent check";
    case QuestionId.Q9:
      return "the dependent rewrite";
    case QuestionId.Q10:
      return "the prior query repair";
  }
  return assertNever(id);
}

function renamedNotice(wiki: ConsoleWiki, from: string | undefined): SafeHtml | null {
  if (from === undefined) return null;
  return notice(
    html`Renamed from <code>${from}</code>. The MCP URL changed: it is now <code>${wiki.url}</code>. A session that
      pinned <code>/wikis/${from}/mcp</code> must add the new URL.`,
  );
}

/**
 * Names a config key that the form edits by the plain label the page shows, in the Config panel and in the form.
 *
 * @param key - the key of `wikifact.json`
 * @returns the label, with its unit where the value has one
 * @sideEffects none
 */
function configLabel(key: ConfigEditKey): string {
  switch (key) {
    case ConfigEditKey.Subject:
      return "Subject";
    case ConfigEditKey.Quality:
      return "Quality preset";
    case ConfigEditKey.Questions:
      return "Question models (JSON)";
    case ConfigEditKey.SearchCap:
      return "Result cap";
    case ConfigEditKey.AgentSearchCap:
      return "Agent result cap";
    case ConfigEditKey.RelevanceFloor:
      return "Relevance floor";
    case ConfigEditKey.Weights:
      return "Weights (JSON)";
    case ConfigEditKey.QuestionTimeout:
      return "Question timeout (s)";
  }
  return assertNever(key);
}

// A half-life in whole days: "30 days".
function days(ms: number): string {
  const n = Math.round(ms / DAY_MS);
  return `${n} ${n === 1 ? "day" : "days"}`;
}

function configPanel(config: Config): SafeHtml {
  const w = config.weights;
  return panel(
    { title: "Config" },
    html`${kv([
        { term: "Mode", value: config.mode },
        { term: "Quality preset", value: config.quality },
        { term: "Subject", value: config.subject },
        { term: "Embedding model", value: config.embeddingModel },
        { term: "Question timeout", value: `${config.questionTimeout} s` },
        { term: "Result cap", value: config.searchCap },
        { term: "Agent result cap", value: config.agentSearchCap },
        { term: "Relevance floor", value: config.relevanceFloor },
      ])}
      <h3>Weights</h3>
      ${kv([
        { term: "Update weight", value: w.wUpdate },
        { term: "Confirm weight", value: w.wConfirm },
        { term: "Read weight", value: w.wRead },
        { term: "Confidence half-life", value: days(w.halfLifeConf) },
        { term: "Use weight", value: w.wUse },
        { term: "Use bound", value: w.useBound },
        { term: "Usefulness half-life", value: days(w.halfLifeUse) },
      ])}`,
  );
}

function questionsPanel(config: Config): SafeHtml {
  return panel(
    { title: "Model questions" },
    table(
      ["Question", "Model", "Effort"],
      enumValues(QuestionId).map((id) => [questionLabel(id), config.questions[id].model, config.questions[id].effort]),
    ),
  );
}

/** The height of a textarea of the forms, in text rows. */
const TEXTAREA_ROWS = 3;

function configField(raw: Readonly<Record<string, unknown>>, key: ConfigEditKey): SafeHtml {
  const value = configText(raw, key);
  const label = configLabel(key);
  if (!isJsonKey(key)) return inputField(key, label, value);
  return textareaField({ name: key, label, value, rows: TEXTAREA_ROWS });
}

// The one panel of the forms of technical/console.md, "Direct edits of non-request fields", with a section per form, open on load.
// Each form asks for the preview first.
function editPanel(wiki: ConsoleWiki, raw: Readonly<Record<string, unknown>>): SafeHtml {
  const params = { w: wiki.name };
  return panel(
    { title: "Edit", note: EDIT_LEAD, span: true },
    html`<section class="form-section">
        <h3>Description</h3>
        ${actionForm({
          action: actionPath(ConsoleAction.SetDescription, params),
          button: "Save description",
          fields: textareaField({
            name: "description",
            label: "Description",
            value: wiki.config.description ?? "",
            rows: TEXTAREA_ROWS,
          }),
        })}
      </section>
      <section class="form-section">
        <h3>Config</h3>
        ${actionForm({
          action: actionPath(ConsoleAction.UpdateConfig, params),
          button: "Save config",
          fields: CONFIG_EDIT_KEYS.map((key) => configField(raw, key)),
        })}
      </section>
      <section class="form-section">
        <h3>Name</h3>
        ${actionForm({
          action: actionPath(ConsoleAction.RenameWiki, params),
          button: "Rename",
          fields: inputField("name", "Name", wiki.name),
        })}
      </section>`,
  );
}

function archiveAction(wiki: ConsoleWiki): DialogAction {
  return dialogAction(
    {
      id: DialogId.Archive,
      label: "Archive",
      action: actionPath(ConsoleAction.ArchiveWiki, { w: wiki.name }),
      submit: "Archive",
      danger: true,
    },
    html`<p class="help">
      The worker stops and the folder moves to the archive. A wiki with no fact, live or deleted, and no queued request
      is removed instead.
    </p>`,
  );
}

/**
 * Renders the settings page at `GET /console/w/:w/settings`.
 *
 * @param ctx - the deps, the wiki in `params.w`, and `renamed` in the query after a rename
 * @returns the HTML document: the resolved config and the model questions; with the console's writes on and a
 *   registry, the forms read from the file as it is and the Archive action; else a notice that says why there is no form
 * @throws {ConsoleError} `NotFound` for an unknown wiki; `ZodError` for a bad query
 * @sideEffects one read-only connection, opened and closed; reads the lock file and signals its pid with 0 for the
 *   status pill; reads `wikifact.json` through the deps when the forms show
 */
export async function settingsPage(ctx: PageContext): Promise<string> {
  const q = parseQuery(ctx.query, settingsQuery);
  const service = ctx.deps.service();
  return withWiki(ctx, ({ wiki, frame }) => {
    let editing: SafeHtml[] = [];
    let archive: DialogAction | undefined;
    let why: SafeHtml | null = null;
    if (!writesAllowed(service)) {
      why = notice("The config is read-only here: the console writes only in local mode on the loopback.");
    } else if (service.target !== ServeTarget.Wikis) {
      why = notice(
        "The config is read-only here: the wiki settings are edited in service mode, and this server serves one database.",
      );
    } else {
      // The forms edit the file as it is, not the resolved config (technical/console.md, "Direct edits of non-request fields").
      editing = [editPanel(wiki, ctx.deps.writes.readRawConfig(wiki.name))];
      archive = archiveAction(wiki);
    }
    return layout(
      {
        ...frame,
        section: ConsoleSection.Settings,
        title: sectionLabel(ConsoleSection.Settings),
        ...(archive === undefined ? {} : { controls: archive.button }),
      },
      html`${renamedNotice(wiki, q.renamed)} ${why}
      ${grid(GridColumns.Two, [configPanel(wiki.config), questionsPanel(wiki.config), ...editing])}
      ${archive?.dialog ?? null}`,
    );
  });
}
