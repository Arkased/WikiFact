// The logger that writes to stderr.
import { formatLine, type Logger } from "./line.js";

/**
 * Makes the logger that writes each line to stderr as one JSON object, `ts` (ISO time) first.
 *
 * @returns a logger bound to `process.stderr`
 * @sideEffects the returned function writes to stderr and reads the clock
 */
export function stderrLogger(): Logger {
  return (line) => {
    process.stderr.write(formatLine(line, new Date()) + "\n");
  };
}
