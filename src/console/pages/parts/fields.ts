// The fields of a GET form (technical/console.md, "Parts"). The fields of a POST form are in `../forms.ts`.
import { html, type SafeHtml } from "../../html.js";
import type { SelectOption } from "../forms.js";

/**
 * Renders a `<select>` of a GET form over value and label pairs, with an "any" option first.
 *
 * @param name - the field name
 * @param label - the label text above the control
 * @param options - the choices in order
 * @param current - the selected value, if any
 * @returns the `label.field` with its `<select>`
 * @sideEffects none
 */
export function optionSelect(
  name: string,
  label: string,
  options: SelectOption[],
  current: string | undefined,
): SafeHtml {
  const tags = options.map(
    (o) => html`<option value="${o.value}" ${o.value === current ? html`selected` : null}>${o.label}</option>`,
  );
  return html`<label class="field"
    >${label}
    <select name="${name}">
      <option value="">any</option>
      ${tags}
    </select></label
  >`;
}

/**
 * Renders a `<select>` of a GET form over the members of an enum, with an "any" option first.
 *
 * @param name - the field name
 * @param label - the label text above the control
 * @param e - the enum
 * @param current - the selected value, if any
 * @returns the `label.field` with its `<select>`; an enum whose values are not plain words goes through `optionSelect`
 *   with its one mapping function
 * @sideEffects none
 */
export function enumSelect<E extends Record<string, string>>(
  name: string,
  label: string,
  e: E,
  current: string | undefined,
): SafeHtml {
  return optionSelect(
    name,
    label,
    Object.values(e).map((v) => ({ value: v, label: v })),
    current,
  );
}

/**
 * Renders a labeled date field of a GET form.
 *
 * @param name - the field name
 * @param label - the label text
 * @param value - the current value as `YYYY-MM-DD`, if any
 * @returns the `label.field` with its `<input type="date">`
 * @sideEffects none
 */
export function dateField(name: string, label: string, value: string | undefined): SafeHtml {
  return html`<label class="field">${label} <input type="date" name="${name}" value="${value ?? ""}" /></label>`;
}

/**
 * Renders a labeled text field of a GET form.
 *
 * @param name - the field name
 * @param label - the label text
 * @param value - the current value, if any
 * @returns the `label.field` with its `<input>`
 * @sideEffects none
 */
export function textField(name: string, label: string, value: string | number | undefined): SafeHtml {
  return html`<label class="field">${label} <input type="text" name="${name}" value="${value ?? ""}" /></label>`;
}

/**
 * Renders a text field of a GET form with a placeholder and no visible label.
 *
 * @param name - the field name
 * @param placeholder - what the box asks for, e.g. "Filter by text"; also its accessible name
 * @param value - the current value, if any
 * @returns the `<input>` inside a `label.field`
 * @sideEffects none
 */
export function filterField(name: string, placeholder: string, value: string | undefined): SafeHtml {
  return html`<label class="field"
    ><input type="text" name="${name}" value="${value ?? ""}" placeholder="${placeholder}" aria-label="${placeholder}"
  /></label>`;
}

/**
 * Renders a labeled number field of a GET form.
 *
 * @param name - the field name
 * @param label - the label text
 * @param value - the current value, if any
 * @returns the `label.field` with its `<input type="number">`; `step="any"` so a fraction such as 0.5 is accepted
 * @sideEffects none
 */
export function numberField(name: string, label: string, value: number | undefined): SafeHtml {
  return html`<label class="field"
    >${label} <input type="number" step="any" name="${name}" value="${value ?? ""}"
  /></label>`;
}

/**
 * Renders a labeled checkbox of a GET form; a checked box sends `1`.
 *
 * @param name - the field name
 * @param label - the label text, after the box
 * @param checked - whether the box is checked
 * @returns the `label.field` with its `<input type="checkbox">`
 * @sideEffects none
 */
export function checkboxField(name: string, label: string, checked: boolean): SafeHtml {
  return html`<label class="field"
    ><input type="checkbox" name="${name}" value="1" ${checked ? html`checked` : null} /> ${label}</label
  >`;
}
