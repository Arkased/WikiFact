import type { ConsumerOut } from "./consumers/types.js";
import type { Data, RequestRow, Task } from "./data.js";
import { must } from "./must.js";

/** A row counts for a task that started at most this long after the row, in ms (clock jitter). */
const WINDOW_LEAD_MS = 50;
/** A row counts for a task that ended at most this long before the row, in ms (the request lands as the task ends). */
const WINDOW_LAG_MS = 1000;

/** The run window of one task and what its consumer reported. */
export interface TimedOut {
  out: ConsumerOut;
  /** The start of the task, in ms since the epoch. */
  startedAt: number;
  /** The end of the task, in ms since the epoch. */
  endedAt: number;
}

/** The input of `assignRows`. */
export interface AssignRowsInput {
  /** The new submission rows of the run. */
  rows: RequestRow[];
  /** The tasks that ran, in order. */
  tasks: Task[];
  /** The window and output of each task, in the order of `tasks`. */
  timed: TimedOut[];
  data: Data;
}

/**
 * Splits the new submission rows over the tasks. A consumer that reports its `requestIds` owns those rows.
 * For the others (the claude consumer), a row goes to a task whose run window holds its arrival time.
 * With several such tasks, it goes to one that the row names, and then to the one with the fewest rows.
 * Totals are exact. Only the owner of a row can be wrong, and only among tasks that ran at the same time.
 *
 * @param input - the rows, the tasks, the windows and the data
 * @returns one list of rows per task, in the order of `tasks`
 * @sideEffects none
 */
export function assignRows(input: AssignRowsInput): RequestRow[][] {
  const { rows, tasks, timed, data } = input;
  const byKey = new Map(data.facts.map((f) => [f.key, f]));
  const out: RequestRow[][] = tasks.map(() => []);
  const claimed = new Set<string>();
  const slot = (i: number): RequestRow[] => must(out[i], `no slot for task ${i}`);
  const windowOf = (i: number): TimedOut => must(timed[i], `no window for task ${i}`);
  timed.forEach((t, i) => {
    for (const id of t.out.requestIds ?? []) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        slot(i).push(row);
        claimed.add(id);
      }
    }
  });
  const open = timed.map((_, i) => i).filter((i) => !windowOf(i).out.requestIds);
  for (const row of rows.filter((r) => !claimed.has(r.id))) {
    if (open.length === 0) break;
    let cands = open.filter(
      (i) =>
        row.received_at >= windowOf(i).startedAt - WINDOW_LEAD_MS &&
        row.received_at <= windowOf(i).endedAt + WINDOW_LAG_MS,
    );
    if (cands.length === 0) {
      // Outside every window: the task that started last before the row.
      const before = open.filter((i) => windowOf(i).startedAt <= row.received_at);
      const last = (before.length ? before : open).sort((a, b) => windowOf(b).startedAt - windowOf(a).startedAt)[0];
      cands = [must(last, "no open task")];
    }
    const text = `${row.change ?? ""} ${row.justification ?? ""}`.toLowerCase();
    const named = cands.filter((i) => {
      const f = must(byKey.get(must(tasks[i], `no task ${i}`).wrong), `no seed fact for task ${i}`);
      const t = data.terms[f.key];
      return (
        text.includes(f.header.toLowerCase()) ||
        (t !== undefined && text.includes(t.subject) && t.any.some((w) => text.includes(w)))
      );
    });
    const pick = (named.length ? named : cands).sort((a, b) => slot(a).length - slot(b).length)[0];
    slot(must(pick, "no candidate task")).push(row);
  }
  return out;
}
