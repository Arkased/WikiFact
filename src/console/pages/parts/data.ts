// The parts of technical/console.md, "Data and interpretation": the definition of a signal, the reading of a number (its
// sentence, shown on hover), and the status line. A page writes neither a definition nor a reading by hand: both come from the 2
// lists of `src/console/`.
import type { HealthLevel, InterpretationId, Signal } from "../../../domain/enums.js";
import { html, type SafeHtml } from "../../html.js";
import { INTERPRETATIONS, type InterpretationData } from "../../interpretations.js";
import { SIGNAL_DEFINITIONS } from "../../signals.js";

// A label with a definition on hover or focus; `key` makes the id of the hidden text unique on the page.
function definedText(key: string, text: string, label: string): SafeHtml {
  const id = `def-${key}`;
  return html`<span class="defined" tabindex="0" data-definition="${text}" title="${text}" aria-describedby="${id}"
      >${label}</span
    ><span class="sr-only" id="${id}">${text}</span>`;
}

/** The info mark at the start of a status line: a circle with an "i", 14 px. */
const INFO_MARK = html`<svg class="info" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
  <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.2" />
  <circle cx="7" cy="4.2" r="0.9" fill="currentColor" />
  <path d="M7 6.4V10.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
</svg>`;

/**
 * Renders the label of a signal with its definition on hover or focus: plain text with a dotted underline, the
 * definition in `data-definition` and `title` (the script shows it in the tooltip), and in a visually hidden element
 * that `aria-describedby` points at.
 *
 * @param signal - the signal whose definition shows
 * @param label - the label text
 * @returns a `span.defined` (focusable) followed by its `span.sr-only` holding the text of `SIGNAL_DEFINITIONS`
 * @sideEffects none
 */
export function definedLabel(signal: Signal, label: string): SafeHtml {
  // A signal can label 2 numbers on a page, so the id holds the label too.
  return definedText(`${signal}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, SIGNAL_DEFINITIONS[signal], label);
}

/**
 * Renders a label with a definition that is no signal (the caption of a chart that counts a thing the page defines), as
 * `definedLabel` does.
 *
 * @param label - the label text; it makes the id of the hidden text, so it is unique on the page
 * @param text - the definition
 * @returns a `span.defined` followed by its `span.sr-only` holding the text
 * @sideEffects none
 */
export function definedPhrase(label: string, text: string): SafeHtml {
  return definedText(`phrase-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, text, label);
}

/**
 * Reads the current numbers with an entry of the list of interpretations: the sentence that a number shows on hover and focus.
 *
 * @param data - the current numbers of the block
 * @param id - the entry of `INTERPRETATIONS`
 * @returns the sentence, or `null` when the data cannot say anything
 * @throws {Error} when the list has no entry with the id
 * @sideEffects none
 */
export function reading(data: InterpretationData, id: InterpretationId): string | null {
  const entry = INTERPRETATIONS.find((i) => i.id === id);
  if (entry === undefined) throw new Error(`no interpretation "${id}"`);
  return entry.read(data);
}

/** One verdict line of a cluster: the level of its row and the sentence, which starts with the level word. */
export interface Verdict {
  level: HealthLevel;
  text: string;
}

/**
 * Renders the status line of Service health (technical/console.md, "Service health"): a rule over the thresholds of the health
 * rows. Each line is the info mark and the sentence, in the color of its level when the level is not ok.
 *
 * @param lines - the verdicts, in order; each text starts with the capitalized level word
 * @param flush - true for the line under the page header: no hairline above it and no panel around it
 * @returns the `ul.interps` of `li.interp`, each holding a `p.reading` with the level as a class; `ul.interps.flush` when flush
 * @sideEffects none
 */
export function verdicts(lines: Verdict[], flush = false): SafeHtml {
  return html`<ul class="${flush ? "interps flush" : "interps"}">
    ${lines.map(
      (l) =>
        html`<li class="interp">
          <p class="reading ${l.level}">${INFO_MARK}<span class="sentence">${l.text}</span></p>
        </li>`,
    )}
  </ul>`;
}
