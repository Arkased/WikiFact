import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** The shape of one command line: which names are flags, which take a value, and which of those repeat. */
export interface ArgSpec {
  /** Boolean flags, without the leading dashes (`stub` for `--stub`). */
  flags?: string[];
  /** Options that take one value; the last occurrence wins. */
  options?: string[];
  /** Options that take a value and may repeat; all values are kept in order. */
  repeatable?: string[];
}

/** The parsed command line. */
export interface ParsedArgs {
  /** Flags that were given. */
  flags: Set<string>;
  /** The value of each single-value option that was given. */
  options: Map<string, string>;
  /** The values of each repeatable option that was given, in order. */
  lists: Map<string, string[]>;
  /** The arguments that are not options, in order (a `--` ends option parsing and the rest lands here). */
  positionals: string[];
}

/**
 * Parses a command line with `node:util` `parseArgs`, strictly: an unknown option throws.
 *
 * @param argv - the arguments after the script name
 * @param spec - the flags, options and repeatable options the command accepts
 * @returns the flags, option values, repeated values and positional arguments
 * @sideEffects none; throws a TypeError on an unknown option or a missing value
 */
export function parseCommandLine(argv: string[], spec: ArgSpec): ParsedArgs {
  const options: ParseArgsOptionsConfig = {};
  for (const f of spec.flags ?? []) options[f] = { type: "boolean" };
  for (const o of spec.options ?? []) options[o] = { type: "string" };
  for (const r of spec.repeatable ?? []) options[r] = { type: "string", multiple: true };
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const out: ParsedArgs = { flags: new Set(), options: new Map(), lists: new Map(), positionals };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "boolean") out.flags.add(name);
    else if (typeof value === "string") out.options.set(name, value);
    else if (Array.isArray(value)) out.lists.set(name, value.map(String));
  }
  return out;
}
