// technical/console.md, "Service health", the high volume mode: the panel "Batch, now" of the Operation page. It shows the newest
// batch: the requests done of those taken, the changes staged and not yet promoted, the stale reruns and the state of the
// reconciliation and the promotion.
import { html, type SafeHtml } from "../html.js";
import { HealthLevel } from "../../domain/enums.js";
import { leveled, untilText, type Facts } from "./health-facts.js";
import { panel, stats } from "./parts/index.js";

/**
 * Builds the panel "Batch, now" of the newest batch.
 *
 * @param f - what the page reads
 * @returns the panel at full width; null while no batch has run
 * @sideEffects none
 */
export function batchPanel(f: Facts): SafeHtml | null {
  const { batch } = f;
  if (batch === undefined) return null;
  const failure = f.status?.lastBatchError;
  return panel(
    { title: "Batch, now" },
    html`${stats([
      { label: "Done", value: `${batch.done} of ${batch.taken}`, under: "requests" },
      { label: "Staged changes", value: batch.staged, under: "in the staging set" },
      { label: "Stale reruns", value: batch.stale },
      { label: "Reconciliation", value: batch.reconciliation },
    ])}
    ${
      failure === undefined
        ? null
        : html`<p class="help">
            ${leveled(HealthLevel.Yellow, `The last batch was dropped at ${untilText(failure.at, f.now)}: ${failure.message}.`)}
            Its requests run one at a time.
          </p>`
    }`,
  );
}
