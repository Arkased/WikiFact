// A stand-in for an npm script of the evals: `node fake-eval.mjs <name> <args...>`.
// It appends the call to FAKE_LOG, and acts on FAKE_EVALS, a JSON object per test name:
// { exit?: number, file?: "stdout" | "folder" | "none", waitForStart?: string } (default: exit 0 and print "results written to <file>").
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args, at: Date.now() }) + "\n");
const spec = JSON.parse(process.env.FAKE_EVALS ?? "{}")[name] ?? {};
const root = process.env.FAKE_ROOT;
const folders = {
  questions: "eval/questions/results",
  relevance: "eval/relevance-results",
  replay: "eval/replay-results",
  corrections: "eval/corrections/results",
  speed: "eval/speed-results",
  benefit: "eval/benefit-results",
};
const dir = join(root, folders[name]);
mkdirSync(dir, { recursive: true });
const file = join(dir, `${name}-result.json`);
writeFileSync(file, JSON.stringify({ name }));
// `waitForStart: <name>` holds this child open until the child <name> has logged its start, so that a test proves
// two children overlap by the order of the log lines, not by a delay. It gives up after 20 s, so that a run which
// never starts <name> ends with an exit code instead of hanging.
if (spec.waitForStart) {
  const started = () =>
    readFileSync(process.env.FAKE_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .some((l) => {
        const line = JSON.parse(l);
        return line.name === spec.waitForStart && !line.end;
      });
  for (let i = 0; i < 1000 && !started(); i++) await new Promise((r) => setTimeout(r, 20));
}
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, end: true, at: Date.now() }) + "\n");
console.log(`${name} running with ${JSON.stringify(args)}`);
if (spec.file === "stdout" || spec.file === undefined) console.log(`results written to ${file}`);
process.exit(spec.exit ?? 0);
