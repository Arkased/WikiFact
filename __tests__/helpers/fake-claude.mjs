// A stand-in for the `claude` binary. It records its arguments and stdin, then answers from FAKE_SCRIPT,
// a JSON array with one entry per call: { exit?, hang?, waitForPeers?, out? } (`out` is printed as the JSON result).
import { appendFileSync, existsSync, readFileSync } from "node:fs";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const log = process.env.FAKE_LOG;
  const n = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const promptFlag = process.argv.indexOf("--system-prompt-file");
  appendFileSync(
    log,
    JSON.stringify({
      argv: process.argv.slice(2),
      systemPrompt: promptFlag < 0 ? null : readFileSync(process.argv[promptFlag + 1], "utf8"),
      stdin,
      pid: process.pid,
      cwd: process.cwd(),
      at: Date.now(),
      configDir: cfg ?? null,
      tempVars: { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR },
      forceCache5m: process.env.FORCE_PROMPT_CACHING_5M ?? null,
      configDirExists: cfg ? existsSync(cfg) : false,
    }) + "\n",
  );
  const script = JSON.parse(process.env.FAKE_SCRIPT);
  const step = script[Math.min(n, script.length - 1)];
  if (step.waitForPeers) {
    // Answers only once `waitForPeers` calls have logged their start, so that a test proves the calls overlap by the
    // calls themselves, not by a delay. It exits with 3 after 10 s, so that serial calls fail the test.
    let polls = 0;
    const timer = setInterval(() => {
      const started = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
      if (started >= step.waitForPeers) {
        clearInterval(timer);
        process.stdout.write(JSON.stringify(step.out));
      } else if (++polls > 500) process.exit(3);
    }, 20);
    return;
  }
  if (step.hang) {
    setInterval(() => {}, 1000);
    return;
  }
  if (step.exit) {
    if (step.out) process.stdout.write(JSON.stringify(step.out));
    else process.stderr.write(step.stderr ?? "login required");
    process.exit(step.exit);
  }
  process.stdout.write(JSON.stringify(step.out));
});
