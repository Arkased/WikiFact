// `npm run eval:benefit -- --db <copy.sqlite> --repo <path> --commit <sha> [--cases <file>] [--runs 10] [--model <id>]
//   [--arm with|without|both] [--group held|gap|stale|all] [--kind question|task|all] [--limit n] [--concurrency 4]
//   [--preload-rounds 3] [--resume <result file>] [--out <result file>] [--verify-cases] [--stub] [--keep]`
// The benefit test of technical/evaluation.md, "The benefit test": the same repo questions and repo tasks through 2
// Claude Code agents, 1 with the wiki tools and 1 without, on a copy of the wiki and a checkout of its fill commit.
// The pieces live in eval/benefit/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadConfig, loadPresets } from "../src/config/index.js";
import { projectRoot } from "../src/paths.js";
import { CallerKind, QuestionId } from "../src/domain/index.js";
import { setEmbedder } from "../src/embed/index.js";
import { loadEnvFile, readEnv } from "../src/env.js";
import { errorMessage } from "../src/must.js";
import { createQuestions, findClaudeBinary, selectTransport } from "../src/updates/index.js";
import { fakeEmbed } from "../fakes/fake-embedder.js";
import { StubQuestions } from "../fakes/stub-questions.js";
import { makeStubWiki, stubAgent, stubChecker, stubJudge, type StubKnowledge } from "../fakes/stub-benefit.js";
import { claudeAgent } from "./benefit/agent.js";
import { armsOf } from "./benefit/arms.js";
import { loadCases, selectCases } from "./benefit/cases.js";
import { modelJudge } from "./benefit/judge.js";
import { formatSummary } from "./benefit/report.js";
import { loadBenefitConfig } from "./benefit/config.js";
import {
  BENEFIT_RESULTS_DIR,
  oldCopyMessage,
  readResultFile,
  resumeMismatches,
  type ResumeIdentity,
} from "./benefit/result-file.js";
import { preloadGoneMessage } from "./benefit/preload.js";
import { runBenefit, type BenefitDeps } from "./benefit/run.js";
import { heldBars } from "./benefit/summary.js";
import { commandChecker } from "./benefit/task-check.js";
import { verifyCases } from "./benefit/verify.js";
import { GitRepo, npmCi } from "./benefit/worktree.js";
import { parseCommandLine, type ParsedArgs } from "./lib/args.js";
import { ArmChoice, GroupChoice, KindChoice } from "./lib/enums.js";
import { resolveWikiDb } from "./lib/envs.js";
import { isMain, lowerPriority } from "./lib/main.js";
import { relativeToRoot } from "./lib/relative-path.js";
import { resultStamp } from "./lib/stamp.js";
import { JSON_INDENT, ARGV_USER_OFFSET, RM_RETRIES, RM_RETRY_DELAY_MS } from "../src/constants.js";

/** The runs of each case and arm when `--runs` is not given. */
const DEFAULT_RUNS = 10;
/** The characters of a commit hash that the log line shows. */
const SHORT_SHA_CHARS = 7;
/** The agent runs in flight when `--concurrency` is not given. */
const DEFAULT_BENEFIT_CONCURRENCY = 4;
/** The most rounds of the preload when `--preload-rounds` is not given. */
const DEFAULT_PRELOAD_ROUNDS = 3;
/** The cases file when `--cases` is not given, relative to the project root. */
const DEFAULT_CASES = join("eval", "benefit.json");
/** The folder of the run folders, in the repo: `clean-temp` works on Temp only, so it never deletes a kept run folder. */
const BENEFIT_WORK_DIR = join(projectRoot(), ".cache", "benefit-work");
/** The exit code for a wrong command line. */
const USAGE_EXIT_CODE = 2;
/** The exit code of a run that stopped before its last job (a rate limit, a failed login) or lost jobs to a fault. */
const INCOMPLETE_EXIT_CODE = 3;
/** The exit code of `--verify-cases` when a case does not hold. */
const VERIFY_EXIT_CODE = 4;
/** The question of the judge in the presets whose `standard` model grades the answers: the judgment question Q2. */
const JUDGE_QUESTION = QuestionId.Q2;

/** The variable that holds the long-lived Claude Code token (`claude setup-token`); with it an agent needs no login in a config folder. */
const OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/** A wrong command line; the message is for the user. */
class UsageError extends Error {}

/** The command line, checked. */
interface CommandOptions {
  db?: string;
  repo: string;
  commit?: string;
  cases: string;
  runs: number;
  /** The model of the agents; absent means the one of `eval/benefit/config.json`. */
  model?: string;
  arm: ArmChoice;
  group: GroupChoice;
  kind: KindChoice;
  limit?: number;
  concurrency: number;
  resume?: string;
  /** The result file to write; default `eval/benefit-results/<stamp>.json`. */
  out?: string;
  /** The most rounds of the preload, 1 or more. */
  preloadRounds: number;
  verifyCases: boolean;
  stub: boolean;
  keep: boolean;
}

function whole(args: ParsedArgs, name: string, fallback: number | undefined, least = 1): number | undefined {
  const text = args.options.get(name);
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < least) throw new UsageError(`--${name} takes a whole number of ${least} or more`);
  return n;
}

function choice<T extends string>(args: ParsedArgs, name: string, values: Record<string, T>, fallback: T): T {
  const text = args.options.get(name);
  if (text === undefined) return fallback;
  const found = Object.values(values).find((v) => v === text);
  if (found === undefined) throw new UsageError(`--${name} takes one of ${Object.values(values).join(", ")}`);
  return found;
}

/**
 * Parses and checks the command line of the benefit test.
 *
 * @param argv - the arguments after the script name
 * @returns the options
 * @throws {UsageError} on a wrong command line or a wiki that the environment does not hold
 * @sideEffects reads the list of environments when `--wiki` is given
 */
export function parseOptions(argv: string[]): CommandOptions {
  let args: ParsedArgs;
  let db: string | undefined;
  try {
    args = parseCommandLine(argv, {
      flags: ["stub", "keep", "verify-cases"],
      options: [
        "env",
        "wiki",
        "db",
        "repo",
        "commit",
        "cases",
        "runs",
        "model",
        "arm",
        "group",
        "kind",
        "limit",
        "concurrency",
        "preload-rounds",
        "resume",
        "out",
      ],
    });
    db = resolveWikiDb({ env: args.options.get("env"), wiki: args.options.get("wiki"), db: args.options.get("db") });
  } catch (e) {
    throw new UsageError(errorMessage(e));
  }
  return {
    db,
    repo: args.options.get("repo") ?? ".",
    commit: args.options.get("commit"),
    cases: args.options.get("cases") ?? DEFAULT_CASES,
    runs: whole(args, "runs", DEFAULT_RUNS) ?? DEFAULT_RUNS,
    model: args.options.get("model"),
    arm: choice(args, "arm", ArmChoice, ArmChoice.Both),
    group: choice(args, "group", GroupChoice, GroupChoice.All),
    kind: choice(args, "kind", KindChoice, KindChoice.All),
    limit: whole(args, "limit", undefined),
    concurrency: whole(args, "concurrency", DEFAULT_BENEFIT_CONCURRENCY) ?? DEFAULT_BENEFIT_CONCURRENCY,
    preloadRounds: whole(args, "preload-rounds", DEFAULT_PRELOAD_ROUNDS, 1) ?? DEFAULT_PRELOAD_ROUNDS,
    resume: args.options.get("resume"),
    out: args.options.get("out"),
    verifyCases: args.flags.has("verify-cases"),
    stub: args.flags.has("stub"),
    keep: args.flags.has("keep"),
  };
}

/** The agent, the judge and the other parts of a run, with the names for the result file. */
interface Parts {
  deps: BenefitDeps;
  agentName: string;
  judgeModel: string;
  isolateConfig: boolean;
}

function chooseParts(opts: CommandOptions, model: string, known: StubKnowledge): Parts {
  const log = (line: string): void => console.error(line);
  if (opts.stub) {
    setEmbedder(fakeEmbed);
    return {
      deps: {
        agent: stubAgent(known, { submits: true }),
        judge: stubJudge(),
        checker: stubChecker(),
        makeQuestions: () => new StubQuestions(),
        install: () => Promise.resolve(),
        log,
      },
      agentName: "stub (scripted, no model call)",
      judgeModel: "stub",
      isolateConfig: false,
    };
  }
  if (opts.verifyCases) {
    // The proof runs the hidden tests only: no agent and no judge.
    const unused = (): Promise<never> => Promise.reject(new Error("the proof of the cases uses no agent and no judge"));
    return {
      deps: {
        agent: unused,
        judge: { judgeAnswer: unused, judgeDiff: unused },
        checker: commandChecker(),
        makeQuestions: () => {
          throw new Error("the proof of the cases uses no worker");
        },
        install: npmCi,
        log,
      },
      agentName: "none",
      judgeModel: "none",
      isolateConfig: false,
    };
  }
  const env = readEnv();
  const bin = findClaudeBinary(env);
  if (!bin) {
    throw new UsageError(
      "No agent works: the `claude` binary is not found. The SDK fallback of the correction test has no file tools, so the benefit test does not use it. Run with --stub to prove the harness.",
    );
  }
  const settings = loadPresets().presets.standard?.[JUDGE_QUESTION];
  if (!settings) throw new UsageError("the standard preset has no setting for the judgment question of the judge");
  const { transport } = selectTransport(CallerKind.Eval, env);
  if (opts.db) {
    // The worker step of the preload runs as the service does: fail now, not after the first round of agent runs.
    try {
      selectTransport(CallerKind.Worker, env, { mode: loadConfig(resolve(opts.db)).mode });
    } catch (e) {
      throw new UsageError(`the preload needs the transport of the worker: ${errorMessage(e)}`);
    }
  }
  return {
    deps: {
      agent: claudeAgent(bin, env),
      judge: modelJudge(transport, settings),
      checker: commandChecker(),
      makeQuestions: (store, config) => createQuestions(config, undefined, { store }),
      install: npmCi,
      log,
    },
    agentName: `claude -p --model ${model}`,
    judgeModel: `${settings.model} (${settings.effort})`,
    isolateConfig: [env.apiKey, env.authToken, env.raw[OAUTH_TOKEN_VAR]].some((v) => v !== undefined && v !== ""),
  };
}

async function run(argv: string[]): Promise<number> {
  loadEnvFile();
  const opts = parseOptions(argv);
  const casesPath = resolve(opts.cases);
  const all = loadCases(casesPath);
  const cases = selectCases(all, { kind: opts.kind, group: opts.group, limit: opts.limit });
  if (cases.length === 0) throw new UsageError("no case matches --kind, --group and --limit");
  const repo = new GitRepo(resolve(opts.repo));
  const commit = await repo.resolve(opts.commit ?? (opts.stub ? "HEAD" : fail("--commit is required")));
  if (opts.stub && opts.verifyCases)
    throw new UsageError("--verify-cases runs the real hidden tests: it does not take --stub");
  const model = opts.model ?? loadBenefitConfig().model;
  const parts = chooseParts(opts, model, { cases, casesPath });
  if (opts.verifyCases) {
    const runDir = mkdtempSync(join(tmpdir(), "wikifact-benefit-"));
    try {
      return await verify({ opts, cases, casesPath, repo, commit, parts, runDir });
    } finally {
      removeRunFolder(runDir, opts.keep);
    }
  }
  const identity: ResumeIdentity = {
    commit,
    model,
    runs: opts.runs,
    arm: opts.arm,
    kind: opts.kind,
    group: opts.group,
    casesFile: relativeToRoot(casesPath),
    cases: cases.length,
    preloadRounds: opts.preloadRounds,
  };
  const resume = opts.resume ? readResultFile(resolve(opts.resume)) : undefined;
  if (resume) {
    const differs = resumeMismatches(resume.meta, identity);
    if (differs.length > 0) throw new UsageError(`--resume names a result file that differs in: ${differs.join(", ")}`);
    const old = oldCopyMessage(resume.rows);
    if (old) throw new UsageError(old);
  }
  const resultPath = opts.resume
    ? resolve(opts.resume)
    : opts.out
      ? resolve(opts.out)
      : join(BENEFIT_RESULTS_DIR, `${resultStamp()}${opts.stub ? "-stub" : ""}.json`);
  // The run folder is in the repo, not in Temp, so that `clean-temp` never deletes the preload copy of a stopped run; the result file names it, so that a resume finds it.
  const runDir = join(BENEFIT_WORK_DIR, basename(resultPath, ".json"));
  const gone = resume ? preloadGoneMessage(runDir, resume.meta.preload, resume.rows) : undefined;
  if (gone) throw new UsageError(gone);
  mkdirSync(runDir, { recursive: true });
  let ended = false;
  try {
    const dbPath = opts.db ? resolve(opts.db) : opts.stub ? await stubWiki(runDir) : fail("--db is required");
    console.error(
      `agent: ${parts.agentName}; judge: ${parts.judgeModel}; commit ${commit.slice(0, SHORT_SHA_CHARS)}; ${cases.length} cases`,
    );
    const outcome = await runBenefit({
      cases,
      casesPath,
      repo,
      commit,
      dbPath,
      arms: armsOf(opts.arm),
      runs: opts.runs,
      concurrency: opts.concurrency,
      model,
      runDir,
      resultPath,
      meta: {
        startedAt: resume?.meta.startedAt ?? new Date().toISOString(),
        commit,
        model,
        judgeModel: parts.judgeModel,
        agent: parts.agentName,
        runs: opts.runs,
        concurrency: opts.concurrency,
        arm: opts.arm,
        kind: opts.kind,
        group: opts.group,
        casesFile: relativeToRoot(casesPath),
        preloadRounds: opts.preloadRounds,
        passCondition:
          "none at the first runs: reported. After them, on the group held: the share right (done for tasks) of the arm with is not below without by a difference that counts, and its mean dollars are below by a difference that counts (a difference counts when its 95% interval does not hold 0).",
      },
      preloadRounds: opts.preloadRounds,
      resume: resume ? { rows: resume.rows, preload: resume.meta.preload } : undefined,
      isolateConfig: parts.isolateConfig,
      deps: parts.deps,
    });
    ended = outcome.stoppedBy === undefined && outcome.failures.length === 0;
    console.log(formatSummary(outcome.summary, heldBars(outcome.summary)));
    console.log(`\nresults: ${relativeToRoot(resultPath)}`);
    if (outcome.stoppedBy)
      console.log(
        `STOPPED: ${outcome.stoppedBy}; ${outcome.skipped} jobs not run. Resume with --resume ${relativeToRoot(resultPath)}`,
      );
    if (outcome.failures.length > 0)
      console.log(`${outcome.failures.length} jobs failed:\n${outcome.failures.join("\n")}`);
    return outcome.stoppedBy !== undefined || outcome.failures.length > 0 ? INCOMPLETE_EXIT_CODE : 0;
  } finally {
    // A run that did not end keeps its folder, so that `--resume` reuses the preload copy in it.
    removeRunFolder(runDir, opts.keep || !ended);
  }
}

// The stub wiki of a `--stub` run with no `--db`, made again in the run folder (a resumed run finds the folder of the stopped one).
function stubWiki(runDir: string): Promise<string> {
  rmSync(join(runDir, "stub-wiki"), {
    recursive: true,
    force: true,
    maxRetries: RM_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS,
  });
  return makeStubWiki(join(runDir, "stub-wiki"));
}

function removeRunFolder(runDir: string, keep: boolean): void {
  if (keep) console.error(`kept: ${runDir}`);
  else rmSync(runDir, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
}

function fail(message: string): never {
  throw new UsageError(message);
}

interface VerifyInput {
  opts: CommandOptions;
  cases: ReturnType<typeof selectCases>;
  casesPath: string;
  repo: GitRepo;
  commit: string;
  parts: Parts;
  runDir: string;
}

// The proof of the cases: one worktree with the dependencies installed, reset between the steps.
async function verify(v: VerifyInput): Promise<number> {
  const worktree = join(v.runDir, "verify-wt");
  await v.repo.addWorktree(v.commit, worktree);
  try {
    await v.parts.deps.install(worktree);
    const report = await verifyCases({
      cases: v.cases,
      casesPath: v.casesPath,
      repo: v.repo,
      commit: v.commit,
      worktree,
      checker: v.parts.deps.checker,
      log: (line) => console.log(line),
    });
    const file = join(BENEFIT_RESULTS_DIR, `cases-${resultStamp()}.json`);
    mkdirSync(BENEFIT_RESULTS_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ commit: v.commit, ...report }, null, JSON_INDENT));
    console.log(
      `\n${report.ok ? "all cases hold" : "SOME CASES DO NOT HOLD"}; proof: ${relativeToRoot(resolve(file))}`,
    );
    return report.ok ? 0 : VERIFY_EXIT_CODE;
  } finally {
    await v.repo.removeWorktree(worktree);
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(ARGV_USER_OFFSET));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    process.exitCode = USAGE_EXIT_CODE;
  }
}

if (isMain(import.meta.url)) {
  lowerPriority();
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
