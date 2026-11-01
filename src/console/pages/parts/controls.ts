// The controls of a page (technical/console.md, "Parts"): the segmented control, the toolbar with its applied chips, the menu, the
// dialog action and the status pill. The menu and the pill are drawn by the shell (`html.ts`), which cannot import
// from `parts/`, so they are defined there and re-exported here.
import type { DialogId } from "../../../domain/enums.js";
import { html, type HtmlValue, type SafeHtml } from "../../html.js";
import { CONFIRM_FIELD } from "../forms.js";

export { menu, statusPill } from "../../html.js";

/** One choice of a segmented control. */
export interface SegmentItem {
  label: string;
  /** The URL with this value. */
  href: string;
  /** True for the value in force. */
  current: boolean;
}

/**
 * Renders a segmented control (technical/console.md, "Parts"): a choice of 2 to 5 values that changes the page.
 *
 * @param ariaLabel - the accessible name of the control, e.g. "Window"
 * @param items - the choices in order; exactly one is current
 * @returns the `nav.segmented`; each choice an `a`, the current one with `aria-current="true"`
 * @sideEffects none
 */
export function segmented(ariaLabel: string, items: SegmentItem[]): SafeHtml {
  return html`<nav class="segmented" aria-label="${ariaLabel}">
    ${items.map((i) =>
      i.current
        ? html`<a href="${i.href}" aria-current="true">${i.label}</a>`
        : html`<a href="${i.href}">${i.label}</a>`,
    )}
  </nav>`;
}

/** A filter in force, shown as a chip that removes it. */
export interface AppliedFilter {
  label: string;
  value: string;
  /** The URL without this filter. */
  href: string;
}

/** A hidden input a toolbar carries. */
interface HiddenField {
  name: string;
  value: string;
}

/** What `toolbar` takes. */
export interface ToolbarOptions {
  /** The fields of the first row, e.g. from `enumSelect`, `textField`, `checkboxField`. */
  fields: HtmlValue[];
  /** The fields of the second row, behind "More filters". */
  more?: HtmlValue[];
  /** The filters in force, one chip each. */
  applied?: AppliedFilter[];
  /** The label of the submit button; "Apply" when absent. */
  submit?: string;
  /** The fields the form carries but does not show: the sort, the status of a segmented control. */
  hidden?: HiddenField[];
}

/** The label of the toolbar's submit button when the page gives none. */
const DEFAULT_SUBMIT = "Apply";

/**
 * Renders a toolbar (technical/console.md, "Parts"): the GET form of the filters over a table, and the chips of the filters in force.
 *
 * @param opts - the fields, the second row, the applied filters, the submit label and the hidden fields
 * @returns the `form.toolbar` (it submits itself on a select or checkbox change through `data-auto`; its submit button,
 *   "Apply" by default, works without the script) with a hidden input per `hidden` entry, then the `ul.applied` when a
 *   filter is in force
 * @sideEffects none
 */
export function toolbar(opts: ToolbarOptions): SafeHtml {
  const more =
    opts.more === undefined || opts.more.length === 0
      ? null
      : html`<details class="more">
          <summary>More filters</summary>
          <div class="more-fields">${opts.more}</div>
        </details>`;
  const applied =
    opts.applied === undefined || opts.applied.length === 0
      ? null
      : html`<ul class="applied">
          ${opts.applied.map(
            (a) => html`<li><a class="chip remove" href="${a.href}">${a.label}: ${a.value} ×</a></li>`,
          )}
        </ul>`;
  const hidden = (opts.hidden ?? []).map((h) => html`<input type="hidden" name="${h.name}" value="${h.value}" />`);
  return html`<form class="toolbar" method="get" data-auto>
      ${hidden} ${opts.fields}
      <button type="submit">${opts.submit ?? DEFAULT_SUBMIT}</button>
      ${more}
    </form>
    ${applied}`;
}

/** What `dialogAction` takes besides the body. */
export interface DialogActionOptions {
  /** The id of the dialog; the button names it in `data-dialog`. */
  id: DialogId;
  /** The label of the button, and the title of the dialog. */
  label: string;
  /** The path the form posts to; the route answers with the preview first (`confirm=0`). */
  action: string;
  /** The label of the submit button; defaults to `label`. */
  submit?: string;
  /** The title of the dialog; defaults to `label`. A row button that says only "Run now" needs the job in the title. */
  title?: string;
  /** Marks the button and the submit as destructive. */
  danger?: boolean;
  /** The dialog is the confirmation: its form posts `confirm=1`, so the route writes and shows no preview. */
  confirmed?: boolean;
}

/** The 2 pieces of a dialog action: the button for the page header or a table row, and the dialog for the end of `main`. */
export interface DialogAction {
  button: SafeHtml;
  dialog: SafeHtml;
}

/**
 * Renders a write action as a button and a dialog (technical/console.md, "Parts", V8).
 *
 * @param opts - the id, the label, the post path, the submit label, the dialog title and whether it is destructive
 * @param body - the fields of the form
 * @returns `button`: `button[data-dialog]`, default or `danger`; `dialog`: `dialog.sheet` named by its title (`aria-labelledby`), holding `form.action` with
 *   the title, a `confirm=0` field (`confirm=1` with `confirmed`), the fields, and the primary (or danger) submit beside a Cancel that closes it
 * @sideEffects none
 */
export function dialogAction(opts: DialogActionOptions, body: HtmlValue): DialogAction {
  const cls = opts.danger === true ? "danger" : "primary";
  const button =
    opts.danger === true
      ? html`<button type="button" class="danger" data-dialog="${opts.id}">${opts.label}</button>`
      : html`<button type="button" data-dialog="${opts.id}">${opts.label}</button>`;
  const dialog = html`<dialog class="sheet" id="${opts.id}" aria-labelledby="${opts.id}-title">
    <form class="action" method="post" action="${opts.action}">
      <h2 id="${opts.id}-title">${opts.title ?? opts.label}</h2>
      <input type="hidden" name="${CONFIRM_FIELD}" value="${opts.confirmed === true ? "1" : "0"}" />
      ${body}
      <div class="buttons">
        <button type="submit" class="${cls}">${opts.submit ?? opts.label}</button>
        <button type="submit" formmethod="dialog" formnovalidate>Cancel</button>
      </div>
    </form>
  </dialog>`;
  return { button, dialog };
}
