// The service rows of the wikis page (technical/console.md, "Wikis"), written once.
import { ServeTarget, assertNever } from "../../../domain/enums.js";
import type { ServiceFacts } from "../../deps.js";
import { html, time } from "../../html.js";
import type { KvRow } from "./blocks.js";

/**
 * Names the path of the service rows by what `serve` serves.
 *
 * @param target - one database or a wikis folder
 * @returns the label of the path row
 * @sideEffects none
 */
function pathLabel(target: ServeTarget): string {
  switch (target) {
    case ServeTarget.Db:
      return "Database";
    case ServeTarget.Wikis:
      return "Wikis directory";
  }
  return assertNever(target);
}

/**
 * Builds the service rows: version, started at, address, mode, the path and the log directory.
 *
 * @param service - the facts of the process
 * @returns the rows for `kv`
 * @sideEffects none
 */
export function serviceRows(service: ServiceFacts): KvRow[] {
  return [
    { term: "Version", value: service.version },
    { term: "Started", value: time(service.startedAt) },
    { term: "Address", value: `${service.host}:${service.port}` },
    { term: "Mode", value: service.mode },
    { term: pathLabel(service.target), value: html`<code>${service.path}</code>` },
    {
      term: "Log directory",
      value:
        service.logDir === undefined
          ? html`<span class="muted">none (stderr)</span>`
          : html`<code>${service.logDir}</code>`,
    },
  ];
}
