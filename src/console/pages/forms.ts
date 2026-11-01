// The form pieces of the write pages (technical/console.md, "Rules for phase 2"): a POST form that asks for the preview first, the note field of
// an operator edit, and the form of the preview page itself.
import { z } from "zod";
import { MAX_NOTE_LENGTH } from "../../store/index.js";
import { html, type HtmlValue, type SafeHtml } from "../html.js";

/** The form field that says the operator saw the preview: `1` writes, anything else shows the preview. */
export const CONFIRM_FIELD = "confirm";

/** The note of an operator edit: 1 to `MAX_NOTE_LENGTH` characters after trimming (technical/console.md, "The `operatorEdit` request"). */
export const noteSchema = z.string().trim().min(1, "a note is required").max(MAX_NOTE_LENGTH);

/** What `actionForm` renders. */
export interface ActionFormOptions {
  /** The path the form posts to. */
  action: string;
  /** The label of the button. */
  button: string;
  /** The visible fields; absent for a form that is a button only. */
  fields?: HtmlValue;
  /** Marks the button as destructive. */
  danger?: boolean;
  /** Renders the form for a table cell: the button alone (technical/console.md, "Parts"). */
  inline?: boolean;
}

/**
 * Renders a POST form that asks for the preview: it sends `confirm=0`, and the route answers with the preview page.
 *
 * @param opts - the path, the button label and the fields
 * @returns the `<form class="action">` with a primary (or danger) button; the inline form of technical/console.md, "Parts", for a
 *   table cell, is the button alone with no class
 * @sideEffects none
 */
export function actionForm(opts: ActionFormOptions): SafeHtml {
  const inline = opts.inline === true;
  const cls = opts.danger === true ? "danger" : inline ? "" : "primary";
  return html`<form ${inline ? null : html`class="action"`} method="post" action="${opts.action}">
    <input type="hidden" name="${CONFIRM_FIELD}" value="0" />
    ${opts.fields ?? null}
    <button type="submit" ${cls === "" ? null : html`class="${cls}"`}>${opts.button}</button>
  </form>`;
}

/**
 * Renders the required note field of an operator edit.
 *
 * @param help - the help line under the field; defaults to the line of an operator edit
 * @returns the `label.field` with a text input for `note`
 * @sideEffects none
 */
export function noteField(help = `Kept with the request, ${MAX_NOTE_LENGTH} characters at most`): SafeHtml {
  return html`<label class="field"
    >Why
    <input type="text" name="note" maxlength="${MAX_NOTE_LENGTH}" size="40" required />
    <span class="help">${help}</span></label
  >`;
}

/**
 * Renders a labeled text field of a POST form.
 *
 * @param name - the field name
 * @param label - the label text
 * @param value - the current value
 * @returns the `label.field` with its `<input>`
 * @sideEffects none
 */
export function inputField(name: string, label: string, value: string | number | undefined): SafeHtml {
  return html`<label class="field">${label} <input type="text" name="${name}" value="${value ?? ""}" /></label>`;
}

/** What `textareaField` takes. */
export interface TextareaFieldOptions {
  /** The field name. */
  name: string;
  /** The label text. */
  label: string;
  /** The current value. */
  value: string;
  /** The height in lines. */
  rows: number;
  /** True when the form refuses an empty value; false when absent. */
  required?: boolean;
}

/**
 * Renders a labeled multi-line field of a POST form.
 *
 * @param opts - the name, the label, the value, the height and whether it is required
 * @returns the `label.field` with its `<textarea>`
 * @sideEffects none
 */
export function textareaField(opts: TextareaFieldOptions): SafeHtml {
  const required = opts.required === true ? html`required` : null;
  return html`<label class="field"
    >${opts.label} <textarea name="${opts.name}" rows="${opts.rows}" ${required}>${opts.value}</textarea>
  </label>`;
}

/** One choice of a select: the value that posts and the text that shows. */
export interface SelectOption {
  value: string;
  label: string;
}

function optionTags(options: SelectOption[], isSelected: (value: string) => boolean): SafeHtml[] {
  return options.map(
    (o) => html`<option value="${o.value}" ${isSelected(o.value) ? html`selected` : null}>${o.label}</option>`,
  );
}

/**
 * Renders a labeled select of a POST form, with no "any" option.
 *
 * @param name - the field name
 * @param label - the label text
 * @param options - the choices in order
 * @param current - the value selected; the first option when absent or not among the options
 * @returns the `label.field` with its `<select>`
 * @sideEffects none
 */
export function selectField(name: string, label: string, options: SelectOption[], current?: string): SafeHtml {
  return html`<label class="field"
    >${label}
    <select name="${name}">
      ${optionTags(options, (v) => v === current)}
    </select></label
  >`;
}

/**
 * Renders the form of a preview page: the fields of the first form as hidden inputs and `confirm=1`.
 *
 * @param action - the path the first form posted to
 * @param fields - the name and value of each field, as the first form sent them
 * @param button - the label of the confirm button
 * @returns the `<form>`
 * @sideEffects none
 */
export function confirmForm(action: string, fields: [string, string][], button: string): SafeHtml {
  return html`<form class="action" method="post" action="${action}">
    <input type="hidden" name="${CONFIRM_FIELD}" value="1" />
    ${fields.map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`)}
    <button type="submit" class="primary">${button}</button>
  </form>`;
}
