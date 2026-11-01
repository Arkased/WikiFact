// Numbers that several modules share, each named once (docs/code-standard.md, section 5). A number that one module owns
// is a `const` in that module.

/** Spaces per indent level in the JSON text and the JSON files that the program writes. */
export const JSON_INDENT = 2;

/**
 * The ids of the questions that were removed. Old presets and result files may still name them; the readers skip them (technical/updates.md, "High volume mode", item "Removed").
 */
export const REMOVED_QUESTION_IDS: ReadonlySet<string> = new Set(["Q7B", "Q5B", "Q11", "Q11B", "Q12", "Q14", "Q15"]);

/** Entries of `process.argv` before the arguments of the user, in count: the Node binary and the script. */
export const ARGV_USER_OFFSET = 2;

/** The exit code of a command line that the script cannot use (a bad flag or a bad value). */
export const EXIT_USAGE = 2;

/** The exit code of a run that finds no credential for the model. */
export const NO_CREDENTIALS_EXIT_CODE = 2;

/** Decimal places of a displayed ratio, rate or price. */
export const DISPLAY_DECIMALS = 2;

/** Digits of one field of a clock time or a date (hour, minute, month, day); a shorter field is padded with zeros. */
export const CLOCK_FIELD_WIDTH = 2;

/** The divisor that takes a half: `width / HALF`. */
export const HALF = 2;

/** The factor by which a retry delay grows after each failed attempt. */
export const BACKOFF_FACTOR = 2;

/** Decimal places of a displayed cost in USD. */
export const COST_DECIMALS = 3;

/** The base of a number written in decimal digits, for `Number.parseInt`. */
export const DECIMAL_RADIX = 10;

/** The base of the round steps of an axis: each decade repeats the multiples of `NICE_STEP_MULTIPLES` (1, 2, 5, 10, 20, 50, ...). */
export const NICE_STEP_BASE = 10;

/** The multiples of a decade that an axis step may take. */
export const NICE_STEP_MULTIPLES = [1, 2, 5];

/** How many times `rmSync` retries a busy file (Windows keeps a file busy for a moment after its process ends). */
export const RM_RETRIES = 5;

/** The wait between two retries of `rmSync`, in milliseconds. */
export const RM_RETRY_DELAY_MS = 100;
