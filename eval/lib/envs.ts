// The deployed environments that the postdeploy evals run against (docs/technical/evaluation.md, "Environments").
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { deployPaths } from "../../scripts/lib/deploy-paths.js";
import { WIKI_DB_FILE } from "../../src/paths.js";

/** The name of the environment that `--env` selects when it is absent: the deployment on this computer. */
export const DEFAULT_ENV = "local";

/** The committed list of environments, next to `eval/`. */
const ENVS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "envs.json");

// `{ "local": true }` is the deployment on this computer, found by the deploy code from the home folder.
const envsFile = z.record(z.string(), z.object({ local: z.literal(true) }).strict());

/** A deployed environment, resolved. */
export interface Environment {
  /** The name in `envs.json`. */
  name: string;
  /** The folder that holds one folder per wiki. */
  wikis: string;
}

/** Where to look; both default to the real ones, and a test points them into its run folder. */
export interface EnvironmentSource {
  /** The list of environments. */
  file?: string;
  /** The home folder that the `local` environment is found from. */
  home?: string;
}

/**
 * Finds one environment of the list.
 *
 * @param name - the name given with `--env`; default `local`
 * @param source - the list file and the home folder
 * @returns the environment, with the folder of its wikis
 * @throws {Error} when the name is not in the list or the list is not valid
 * @sideEffects reads the list file; reads the home folder name only, never the deployment
 */
export function loadEnvironment(name: string = DEFAULT_ENV, source: EnvironmentSource = {}): Environment {
  const list = envsFile.parse(JSON.parse(readFileSync(source.file ?? ENVS_FILE, "utf8")));
  if (!Object.hasOwn(list, name)) throw new Error(`--env ${name} is not in the list (${Object.keys(list).join(", ")})`);
  return { name, wikis: deployPaths(source.home ?? homedir()).wikis };
}

/** The options of a command that reads a wiki. */
export interface WikiSelection {
  /** `--env`: the environment of `--wiki`. */
  env?: string;
  /** `--wiki`: a wiki of the environment. */
  wiki?: string;
  /** `--db`: a wiki file of the test data. */
  db?: string;
}

/**
 * Finds the database file of the wiki that a command reads. The eval never writes it: each eval copies it with the
 * SQLite backup API before it works.
 *
 * @param pick - `--env`, `--wiki` and `--db` as given
 * @param source - the list file and the home folder
 * @returns the path of the wiki file, or undefined when neither `--wiki` nor `--db` is given
 * @throws {Error} for `--wiki` with `--db`, `--env` without `--wiki`, a `--wiki` that is not a plain folder name, an
 *   unknown environment or a wiki the environment does not hold
 * @sideEffects reads the list file and checks that the wiki file exists
 */
export function resolveWikiDb(pick: WikiSelection, source: EnvironmentSource = {}): string | undefined {
  if (pick.wiki !== undefined && pick.db !== undefined) throw new Error("--wiki and --db exclude each other");
  if (pick.wiki === undefined) {
    if (pick.env !== undefined) throw new Error("--env needs --wiki");
    return pick.db;
  }
  if (pick.wiki === "" || pick.wiki === "." || pick.wiki === ".." || basename(pick.wiki) !== pick.wiki) {
    throw new Error(`--wiki ${pick.wiki} is not a plain folder name`);
  }
  const env = loadEnvironment(pick.env, source);
  const db = join(env.wikis, pick.wiki, WIKI_DB_FILE);
  if (!existsSync(db)) throw new Error(`--wiki ${pick.wiki} is not a wiki of the environment ${env.name}`);
  return db;
}
