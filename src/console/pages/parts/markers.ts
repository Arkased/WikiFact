// The markers, badges and the meter of technical/console.md, "Interactions".
import {
  ChangeOutcome,
  HealthLevel,
  MarkerClass,
  RejectReason,
  RequestStatus,
  VersionWrite,
  assertNever,
} from "../../../domain/enums.js";
import { html, type SafeHtml } from "../../html.js";
import { DISPLAY_DECIMALS } from "../../../constants.js";

/**
 * Renders a confidence as the meter of technical/console.md, "Interactions": the number, then a track filled to the confidence.
 *
 * @param confidence - 0 to 1
 * @returns a `span.meter` holding the number with 2 decimals and a native `meter` element; the fill is the element's
 *   value, so the markup carries no style attribute
 * @sideEffects none
 */
export function meter(confidence: number): SafeHtml {
  const text = confidence.toFixed(DISPLAY_DECIMALS);
  return html`<span class="meter" title="${text}">${text} <meter min="0" max="1" value="${text}"></meter></span>`;
}

/**
 * Renders a marker pill (technical/console.md, "Interactions").
 *
 * @param text - the word in the pill, e.g. `deleted`
 * @param cls - the tone of the pill
 * @param title - the explanation on hover, if any
 * @returns the `<span>`
 * @sideEffects none
 */
export function marker(text: string, cls: MarkerClass, title?: string): SafeHtml {
  if (title === undefined) return html`<span class="${cls}">${text}</span>`;
  return html`<span class="${cls}" title="${title}">${text}</span>`;
}

/**
 * Renders the live or deleted marker of a fact.
 *
 * @param isDeleted - whether the current version is a deletion
 * @returns the marker
 * @sideEffects none
 */
export function liveMarker(isDeleted: boolean): SafeHtml {
  return isDeleted ? marker("deleted", MarkerClass.Bad) : marker("live", MarkerClass.Live);
}

/**
 * Renders the status of a request as a marker.
 *
 * @param status - the status
 * @returns the marker; queued and running share a tone, done is good, failed is bad and reads `failing`
 * @sideEffects none
 */
export function statusMarker(status: RequestStatus): SafeHtml {
  switch (status) {
    case RequestStatus.Queued:
    case RequestStatus.Running:
      return marker(status, MarkerClass.Queued);
    case RequestStatus.Done:
      return marker(status, MarkerClass.Done);
    case RequestStatus.Failed:
      return marker(levelWord(HealthLevel.Red), MarkerClass.Bad);
  }
  return assertNever(status);
}

/**
 * Renders the one marker of a request in a list: its outcome when it is done, else its status.
 *
 * @param status - the status of the request
 * @param outcome - the outcome of its last change; null while it has none
 * @param reason - the reject reason of a rejected change
 * @returns the outcome marker for a done request that has an outcome, else the status marker
 * @sideEffects none
 */
export function resultMarker(
  status: RequestStatus,
  outcome: ChangeOutcome | null,
  reason: RejectReason | null = null,
): SafeHtml {
  return status === RequestStatus.Done && outcome !== null ? outcomeMarker(outcome, reason) : statusMarker(status);
}

/**
 * Renders the outcome of a request as a marker, with the reject reason in the word.
 *
 * @param outcome - the outcome of the last change; null while the request has none
 * @param reason - the reject reason of a rejected change
 * @returns the marker, or a muted dash while there is no outcome
 * @sideEffects none
 */
export function outcomeMarker(outcome: ChangeOutcome | null, reason: RejectReason | null = null): SafeHtml {
  if (outcome === null) return html`<span class="muted">-</span>`;
  const word = reason === null ? outcome : `${outcome}: ${reason}`;
  switch (outcome) {
    case ChangeOutcome.Accepted:
      return marker(word, MarkerClass.Live);
    case ChangeOutcome.Duplicate:
      return marker(word, MarkerClass.Derived);
    case ChangeOutcome.Rejected:
      return marker(word, MarkerClass.Bad);
    case ChangeOutcome.Split:
      return marker(word, MarkerClass.Derived);
  }
  return assertNever(outcome);
}

/**
 * Renders the kind of write of a fact version as a marker.
 *
 * @param kind - new, changed, deleted or revived
 * @returns the marker
 * @sideEffects none
 */
export function writeMarker(kind: VersionWrite): SafeHtml {
  switch (kind) {
    case VersionWrite.New:
    case VersionWrite.Revived:
      return marker(kind, MarkerClass.Live);
    case VersionWrite.Changed:
      return marker(kind, MarkerClass.Derived);
    case VersionWrite.Deleted:
      return marker(kind, MarkerClass.Bad);
  }
  return assertNever(kind);
}

/**
 * Names a health level by the word the console shows (technical/console.md, "Parts"): never the color.
 *
 * @param level - the level
 * @returns `ok`, `warning` or `failing`
 * @sideEffects none
 */
export function levelWord(level: HealthLevel): string {
  switch (level) {
    case HealthLevel.Green:
      return "ok";
    case HealthLevel.Yellow:
      return "warning";
    case HealthLevel.Red:
      return "failing";
  }
  return assertNever(level);
}

/**
 * Renders a health level as a colored badge.
 *
 * @param level - the level
 * @returns a `<span class="badge">` with the level as a second class and the level word as text
 * @sideEffects none
 */
export function levelBadge(level: HealthLevel): SafeHtml {
  return html`<span class="badge ${level}">${levelWord(level)}</span>`;
}

/**
 * Renders "none" in the muted tone, for an empty value.
 *
 * @returns the `<span>`
 * @sideEffects none
 */
export function none(): SafeHtml {
  return html`<span class="muted">none</span>`;
}

/**
 * Renders a dash in the muted tone, for a value a row does not have.
 *
 * @returns the `<span>`
 * @sideEffects none
 */
export function dash(): SafeHtml {
  return html`<span class="muted">-</span>`;
}
