// A fake `ShipIo` for the tests of the ship command: it records the order of the steps, and `over` replaces single
// calls. The ship test and the requirement tests of release and deployment share it.
import type { Proof, ShipIo } from "../../lib/ship.js";

/** The schema version of the code in the ship tests. */
export const CODE_SCHEMA = 6;

/**
 * A proof in which every check passed.
 *
 * @returns the proof
 * @sideEffects none
 */
export function goodProof(): Proof {
  return {
    portAnswers: true,
    consoleHasVersion: true,
    schemas: [{ wiki: "wikifact", stored: CODE_SCHEMA, code: CODE_SCHEMA }],
    listening: '{"event":"listening","ts":"2026-10-14T03:00:05.000Z"}',
  };
}

/**
 * A ship io that records the order of the steps in `calls`.
 *
 * @param calls - receives one name for each step that runs
 * @param over - replaces single calls
 * @param proof - what the proof step returns; default a passed proof
 * @returns the io
 * @sideEffects none; the returned calls push to `calls` and the deploy call logs through its argument
 */
export function fakeIo(calls: string[], over: Partial<ShipIo> = {}, proof: Proof = goodProof()): ShipIo {
  return {
    requireCleanTree: () => void calls.push("clean"),
    branch: () => "build",
    check: () => void calls.push("check"),
    release: () => {
      calls.push("release");
      return "v0.1.19";
    },
    backups: () => {
      calls.push("backups");
      return Promise.resolve([]);
    },
    deploy: (log) => {
      calls.push("deploy");
      log("started the scheduled task WikiFact");
      return Promise.resolve();
    },
    proof: () => {
      calls.push("proof");
      return Promise.resolve(proof);
    },
    changes: () => ["Tag work"],
    now: () => new Date("2026-10-14T03:00:00.000Z"),
    commitEntry: (version) => void calls.push(`entry ${version}`),
    log: () => undefined,
    ...over,
  };
}
