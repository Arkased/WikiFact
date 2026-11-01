// The links to the object pages of a wiki: a fact and a request (technical/console.md, "Routes").
import { ConsoleSection } from "../../../domain/enums.js";
import { html, wikiPath, type SafeHtml } from "../../html.js";

/**
 * Builds the URL of an object page of a wiki.
 *
 * @param wiki - the wiki name
 * @param section - the list the object belongs to
 * @param id - the object's id or seq
 * @returns `/console/w/<wiki>/<section>/<id>`
 * @sideEffects none
 */
export function objectPath(wiki: string, section: ConsoleSection, id: string | number): string {
  return `${wikiPath(wiki, section)}/${encodeURIComponent(String(id))}`;
}

/**
 * Links a fact to its page.
 *
 * @param wiki - the wiki name
 * @param id - the fact id
 * @param text - the link text; default the id
 * @returns the `<a>`
 * @sideEffects none
 */
export function factLink(wiki: string, id: string, text: string = id): SafeHtml {
  return html`<a href="${objectPath(wiki, ConsoleSection.Facts, id)}">${text}</a>`;
}

/**
 * Links a request to its page.
 *
 * @param wiki - the wiki name
 * @param id - the request id
 * @returns the `<a>` with the id as text
 * @sideEffects none
 */
export function requestLink(wiki: string, id: string): SafeHtml {
  return html`<a href="${objectPath(wiki, ConsoleSection.Requests, id)}">${id}</a>`;
}
