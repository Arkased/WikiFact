// The shape of a write route (technical/console.md, "Rules for phase 2"): a zod-validated form, a preview page first, then the write, a log line
// and a redirect. Each action file declares its routes through `defineWrite`; `post.ts` serves them.
import type { z } from "zod";
import { ConsoleErrorKind, LogEvent, LogLevel, type ConsoleAction } from "../domain/enums.js";
import { errorMessage } from "../must.js";
import { WikiError } from "../service/errors.js";
import { closeStore, openStoreFor, type Store } from "../store/index.js";
import type { ConsoleDeps, ConsoleWiki } from "./deps.js";
import { ConsoleError, unknownWiki } from "./errors.js";
import { html, layout, type LayoutOptions, type SafeHtml } from "./html.js";
import { CONFIRM_FIELD, confirmForm } from "./pages/forms.js";
import { panel, readStatusPill } from "./pages/parts/index.js";
import { actionPath, actionTemplate } from "./write-paths.js";

/** What a write handler gets: the deps and the path parameters. */
export interface WriteContext {
  deps: ConsoleDeps;
  /** The path parameters by name: `w` for the wiki, `id` for the request. */
  params: Record<string, string>;
}

/** What a finished write returns. */
interface WriteDone {
  /** The path the route redirects to (303). */
  location: string;
  /** The id the action names (a request), for the log line. */
  id?: string;
  /** The wiki the log line names when it is not the `w` of the path (a created or renamed wiki). */
  wiki?: string;
}

/** The answer of a write route: the preview page (200) or the redirect (303). */
export type WriteAnswer = { html: string } | { location: string };

/** The declaration of one write route. `S` is the zod schema of the form without the `confirm` field. */
export interface WriteSpec<S extends z.ZodObject> {
  action: ConsoleAction;
  /** The title of the preview page. */
  title: string;
  /** The label of the confirm button on the preview page. */
  button: string;
  schema: S;
  /**
   * Checks that the write can go ahead and says what it will do. Absent for a read, which runs at once.
   *
   * @param ctx - the deps and the path parameters; the wiki and the object are looked up here, not in `fields`
   * @param fields - the parsed form, as the first form sent it
   * @returns the exact edit, as the preview page shows it
   * @throws {ConsoleError} `NotFound` or `Refused` when the write cannot go ahead
   * @sideEffects none, or a read of the wiki's store; it writes nothing
   */
  describe?(ctx: WriteContext, fields: z.infer<S>): SafeHtml | Promise<SafeHtml>;
  /**
   * Does the write.
   *
   * @param ctx - the deps and the path parameters; the wiki and the object are looked up here, not in `fields`
   * @param fields - the parsed form, as the confirm form sent it
   * @returns where to redirect, and the id and wiki for the log line
   * @throws {ConsoleError} `NotFound` or `Refused` when the write is refused
   * @sideEffects the write itself: a queue row, a registry call or a file; the route logs the action after it
   */
  run(ctx: WriteContext, fields: z.infer<S>): WriteDone | Promise<WriteDone>;
  /**
   * Gives the target of the cancel link of the preview page.
   *
   * @param ctx - the deps and the path parameters, which name the page the write started from
   * @param fields - the parsed form, for a route whose cancel target depends on it
   * @returns the path of the page the operator came from
   * @sideEffects none
   */
  back(ctx: WriteContext, fields: z.infer<S>): string;
}

/** One POST route of the table: the path template and its handler. */
export interface WriteRoute {
  action: ConsoleAction;
  template: string;
  /**
   * Answers one POST.
   *
   * @param ctx - the deps and the path parameters of the matched template
   * @param form - the parsed body; `confirm=1` writes, anything else shows the preview
   * @returns the preview page, or the redirect after the write
   * @throws {ZodError} for a bad form; {ConsoleError} for an unknown object or a refusal
   * @sideEffects the `run` of the route after a confirmed form, then one `LogEvent.ConsoleAction` line; none for a preview
   */
  handle(ctx: WriteContext, form: URLSearchParams): Promise<WriteAnswer>;
}

/**
 * Declares a write route.
 *
 * @param spec - the schema, the preview and the write
 * @returns the route; its handler shows the preview unless the form says `confirm=1`, and logs one
 *   `LogEvent.ConsoleAction` line after a write
 * @sideEffects none; the handler does what `spec.run` does
 */
export function defineWrite<S extends z.ZodObject>(spec: WriteSpec<S>): WriteRoute {
  return {
    action: spec.action,
    template: actionTemplate(spec.action),
    handle: async (ctx, form) => {
      const fields = spec.schema.parse(formRecord(form));
      if (spec.describe !== undefined && form.get(CONFIRM_FIELD) !== "1") {
        const edit = await spec.describe(ctx, fields);
        const hidden = Object.keys(spec.schema.shape).flatMap((name): [string, string][] =>
          form.getAll(name).map((value): [string, string] => [name, value]),
        );
        return { html: previewPage(ctx, spec, { edit, hidden, back: spec.back(ctx, fields) }) };
      }
      const done = await spec.run(ctx, fields);
      const id = done.id;
      ctx.deps.log({
        event: LogEvent.ConsoleAction,
        level: LogLevel.Info,
        action: spec.action,
        wiki: done.wiki ?? ctx.params.w ?? "",
        ...(id === undefined ? {} : { id }),
      });
      return { location: done.location };
    },
  };
}

// A field sent more than once (a multi-select) is an array; the others are strings.
function formRecord(form: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    out[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return out;
}

/** What the preview page shows besides the title and the button. */
interface PreviewBody {
  /** The exact edit. */
  edit: SafeHtml;
  /** The fields of the first form, echoed as hidden inputs. */
  hidden: [string, string][];
  /** Where the cancel link goes. */
  back: string;
}

function previewPage<S extends z.ZodObject>(
  ctx: WriteContext,
  spec: WriteSpec<S>,
  { edit, hidden, back }: PreviewBody,
): string {
  return layout(
    { title: spec.title, lead: "Nothing is written yet. This is the edit.", ...previewFrame(ctx) },
    panel(
      { title: "The edit" },
      html`${edit} ${confirmForm(actionPath(spec.action, ctx.params), hidden, spec.button)}
        <p class="help"><a href="${back}">Cancel</a></p>`,
    ),
  );
}

// The frame of the page the edit came from (technical/console.md, "Preview and error pages"): the wiki list, and for a write on a wiki the wiki,
// its status pill and the version. A write with no wiki (create) has no pill.
function previewFrame(ctx: WriteContext): Pick<LayoutOptions, "wikis" | "wiki" | "status" | "version"> {
  const wikis = ctx.deps.listWikis().map((w) => w.name);
  const { version } = ctx.deps.service();
  const wiki = ctx.deps.getWiki(ctx.params.w ?? "");
  if (wiki === undefined) return { wikis, version };
  const store = openStoreFor(wiki.config, wiki.dbPath, { readonly: true });
  try {
    return { wikis, wiki: wiki.name, status: readStatusPill(store, wiki, Date.now()), version };
  } finally {
    closeStore(store);
  }
}

/**
 * Finds the wiki of the `w` path parameter.
 *
 * @param ctx - the deps and the path parameters; `params.w` names the wiki
 * @returns the wiki as the deps list it
 * @throws {ConsoleError} `NotFound` when the wiki is unknown
 * @sideEffects none
 */
export function needWiki(ctx: WriteContext): ConsoleWiki {
  const name = ctx.params.w ?? "";
  const wiki = ctx.deps.getWiki(name);
  if (wiki === undefined) throw unknownWiki(name);
  return wiki;
}

/**
 * Opens a write connection on a wiki, runs a function and closes it.
 *
 * @param wiki - the wiki whose database file is opened, read-write
 * @param fn - the work; it gets the open store, which is closed when `fn` returns or throws
 * @returns what `fn` returns
 * @sideEffects opens and closes one write connection to the wiki's database (the table `change_requests`, and the `queue_pause` key of `meta`; design/console.md, "The rule that splits the edits", "The pause of the queue")
 */
export function withWriteStore<T>(wiki: ConsoleWiki, fn: (store: Store) => T): T {
  const store = openStoreFor(wiki.config, wiki.dbPath);
  try {
    return fn(store);
  } finally {
    closeStore(store);
  }
}

/**
 * Runs a registry call and turns its refusal into a 409.
 *
 * @param fn - the call
 * @returns what `fn` returns
 * @throws {ConsoleError} `Refused` with the message of the `WikiError`
 * @sideEffects whatever `fn` does
 */
export async function refusing<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConsoleError) throw e;
    if (e instanceof WikiError) throw new ConsoleError(ConsoleErrorKind.Refused, errorMessage(e));
    throw e;
  }
}
