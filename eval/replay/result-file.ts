import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONCURRENCY } from "../lib/pool.js";
import { resultStamp } from "../lib/stamp.js";
import { EVAL_DIR } from "./load.js";
import { runReplay } from "./run.js";
import type { ReplayMeta, ReplayOptions, ReplayReport, ReplayResultFile } from "./types.js";
import { JSON_INDENT } from "../../src/constants.js";

/**
 * Names the results file of a run that has no `--out`.
 *
 * @returns `eval/replay-results/<stamp>.json` under the project
 * @sideEffects reads the clock
 */
export function defaultReplayOut(): string {
  return join(EVAL_DIR, "replay-results", `${resultStamp()}.json`);
}

/**
 * Runs the replay and writes the results file after every case, so that a stopped run leaves data.
 *
 * @param opts - the replay options
 * @param meta - the mode, transport and models to record
 * @param outPath - the results file; its folder is made when it is missing
 * @returns the report and the file as written
 * @sideEffects writes `outPath` repeatedly; see `runReplay` for the rest
 */
export async function runReplayToFile(
  opts: ReplayOptions,
  meta: ReplayMeta,
  outPath: string,
): Promise<{ report: ReplayReport; file: ReplayResultFile }> {
  const file: ReplayResultFile = {
    startedAt: new Date().toISOString(),
    complete: false,
    mode: meta.mode,
    transport: meta.transport,
    models: meta.models,
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    usage: { input: 0, output: 0 },
    results: [],
  };
  const flush = (): void => {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(file, null, JSON_INDENT) + "\n");
  };
  flush();
  const report = await runReplay({
    ...opts,
    onResult: (r) => {
      file.results.push(r);
      file.usage.input += r.tokens?.input ?? 0;
      file.usage.output += r.tokens?.output ?? 0;
      flush();
      opts.onResult?.(r);
    },
  });
  file.results = report.results; // the order of the case file
  file.pass = report.pass;
  file.complete = true;
  file.finishedAt = new Date().toISOString();
  flush();
  return { report, file };
}
