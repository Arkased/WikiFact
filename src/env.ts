// The environment: the one module that reads process.env. `readEnv` parses the variables of the `EnvVar` enum
// once into a typed object. `loadEnvFile` parses one `.env` file with dotenv and sets each
// key on process.env only when the key is absent there. A value is never logged.
// Order of precedence: process.env, then the first `.env` found: next to the database, at the wikis root, or at the
// project root (technical/deployment.md, "Local mode"). Only that one file is read.
import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EnvVar, TransportName, isMember } from "./domain/enums.js";
import { projectRoot } from "./paths.js";

/** The value that turns on a flag variable (`WIKIFACT_CLI_BARE`, `WIKIFACT_LOG_CALLS`). */
const FLAG_ON = "1";

/** The environment variables of the program, parsed once. An absent or empty variable is `undefined` or `false`. */
export interface Env {
  /**
   * The environment that was read. For the child process of the CLI transport (the whole environment) and for
   * `findClaudeBinary` (home directory, PATH).
   */
  raw: NodeJS.ProcessEnv;
  /** `WIKIFACT_TRANSPORT` when it names a transport. A value that does not is left to `selectTransport` to reject. */
  transport?: TransportName;
  /** `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** `ANTHROPIC_AUTH_TOKEN`. */
  authToken?: string;
  /** `ANTHROPIC_CONFIG_DIR`. */
  anthropicConfigDir?: string;
  /** `WIKIFACT_CLAUDE_BIN`: the path of the `claude` binary. */
  claudeBin?: string;
  /** `CLAUDE_CONFIG_DIR`. */
  claudeConfigDir?: string;
  /** `WIKIFACT_PRESETS`: the path of the presets file, an operator override. */
  presetsPath?: string;
  /** `WIKIFACT_HOOK_LOG`. */
  hookLog?: string;
  /** `WIKIFACT_CLI_BARE` is `1`. */
  cliBare: boolean;
  /** `WIKIFACT_LOG_CALLS` is `1`. */
  logCalls: boolean;
}

/**
 * Parses the environment variables of the program into a typed object.
 *
 * @param env - the environment to read; default `process.env`
 * @returns the parsed variables; an empty variable counts as absent
 * @sideEffects reads `process.env` when no environment is given
 */
export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const text = (name: EnvVar): string | undefined => {
    const v = env[name];
    return v === undefined || v === "" ? undefined : v;
  };
  const transport = text(EnvVar.WikifactTransport);
  return {
    raw: env,
    transport: isMember(TransportName, transport) ? transport : undefined,
    apiKey: text(EnvVar.AnthropicApiKey),
    authToken: text(EnvVar.AnthropicAuthToken),
    anthropicConfigDir: text(EnvVar.AnthropicConfigDir),
    claudeBin: text(EnvVar.WikifactClaudeBin),
    claudeConfigDir: text(EnvVar.ClaudeConfigDir),
    presetsPath: text(EnvVar.WikifactPresets),
    hookLog: text(EnvVar.WikifactHookLog),
    cliBare: env[EnvVar.WikifactCliBare] === FLAG_ON,
    logCalls: env[EnvVar.WikifactLogCalls] === FLAG_ON,
  };
}

/** The variables that `os.tmpdir()` reads, on Windows and on POSIX. */
const TEMP_ENV_NAMES: readonly string[] = ["TEMP", "TMP", "TMPDIR"];

/**
 * Copies an environment with `TEMP`, `TMP` and `TMPDIR` set to a folder, so that a child process makes its temp files
 * there and not in the Temp folder of the user.
 *
 * @param base - the environment to copy
 * @param folder - the folder that becomes the temp folder of the child
 * @returns a new environment; `base` is not changed
 * @sideEffects none
 */
export function withTempFolder(base: NodeJS.ProcessEnv, folder: string): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of TEMP_ENV_NAMES) env[name] = folder;
  return env;
}

/** The options of `loadEnvFile`. `root` and `env` are for tests. */
export interface LoadEnvFileOptions {
  /** The database path; a `.env` in its folder is looked up first. */
  dbPath?: string;
  /** The wikis root of service mode; a `.env` in it is looked up second. */
  wikisDir?: string;
  /** The project root. Default: found from this module. */
  root?: string;
  /** The environment to fill. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Loads one `.env` file into the environment, setting only the keys that are absent. Never logs a value. The lookup
 * order is the folder of the database, the wikis root, then the project root; the first file found wins and the
 * others are not read.
 *
 * @param opts - the database path, the wikis root, and the project root and the environment for tests
 * @returns the names of the keys that it set, never their values; empty when no file exists or every key was set
 * @sideEffects reads up to three paths to find a `.env` and reads one file (an unreadable file is skipped); mutates
 *   `process.env` (or `opts.env`)
 */
export function loadEnvFile(opts: LoadEnvFileOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const files: string[] = [];
  if (opts.dbPath) files.push(join(dirname(resolve(opts.dbPath)), ".env"));
  if (opts.wikisDir) files.push(join(resolve(opts.wikisDir), ".env"));
  files.push(join(opts.root ?? projectRoot(), ".env"));
  const set: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = dotenv.parse(readFileSync(file));
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined) {
        env[k] = v;
        set.push(k);
      }
    }
    break;
  }
  return set;
}
