// The public surface of the log module: the typed line, the stderr logger and the file logger.
export { type LogLine, type Logger } from "./line.js";
export { stderrLogger } from "./stderr.js";
export {
  fileLogger,
  fileLoggerRolls,
  logBaseName,
  processLogger,
  rollOptions,
  writesCallLog,
  type FileLogger,
  type ProcessLogger,
} from "./file.js";
