// The claims of the bulk test submissions (technical/updates.md, "The wiki of the bulk test"), as [change, justification]
// pairs by kind. `bulk-submissions.ts` gives each its kind and expected outcome and orders them. Every claim is checked
// against the docs and the code of this repo; the corrections target the seed facts that are out of date on purpose.

import { JustificationKind } from "../eval/lib/enums.js";

/** A claim of one kind: `[change, justification]`, and for a duplicate, a correction or a contradicted claim, the seed header. */
export type Entry = [change: string, justification: string, seed?: string];

/** A claim whose justification has no observation: `[change, justification, kind of the justification]`. */
export type UnsupportedEntry = [change: string, justification: string, kind: JustificationKind];

/** The claim of a group on one new subject: `[change, justification]`. */
export type Member = [change: string, justification: string];

/** True claims that the seed wiki does not hold. */
export const NEW_FACTS: Entry[] = [
  [
    "The command npm run demo:seed creates the demo wiki with 10 facts and 3 tags.",
    "I read the header of scripts/seed-demo.ts: it reports 10 facts and 3 tags.",
  ],
  [
    "The command npm run demo:seed deletes an existing database file at its path.",
    "I read scripts/seed-demo.ts: it removes the database file and its side files before it seeds.",
  ],
  [
    "The command npm run demo:seed writes a wikifact.json in local mode when the folder of the database has none.",
    "I read scripts/seed-demo.ts: it writes the file with the mode local only when none exists.",
  ],
  [
    "The command npm test runs the unit tests alone.",
    "I read the Develop section of README.md: npm test is the unit tests alone.",
  ],
  [
    "The command npm run test:ui runs the browser test of the console alone.",
    "I read the Develop section of README.md and the test:ui script in package.json.",
  ],
  [
    "The format check of npm run check keeps a content-based cache.",
    "I read the check:format script in package.json: it passes --cache-strategy content.",
  ],
  [
    "The unit tests and the browser test of npm run check run at the same time.",
    "I read check:steps in package.json and section 6 of docs/code-standard.md: run-p starts them together.",
  ],
  [
    "The dead code check reports a dependency that sits in the wrong group.",
    "I read section 6 of docs/code-standard.md, on npm run check:dead.",
  ],
  ["The file package-lock.json pins the version of each library.", "I read section 5 of docs/code-standard.md."],
  [
    "A library module in src/ does not call console.",
    "I read section 5 of docs/code-standard.md, where the rule is tagged lint.",
  ],
  [
    "An index file exports the public surface of its folder and holds no logic.",
    "I read section 2 of docs/code-standard.md.",
  ],
  [
    "No file in the repo carries an absolute local path.",
    "I read section 2 of docs/code-standard.md, where the rule is tagged script.",
  ],
  ["An object type in the code is an interface, not a type alias.", "I read section 4 of docs/code-standard.md."],
  [
    "A switch over an enum has no default branch, so that the compiler reports a missing case.",
    "I read section 1 of docs/code-standard.md.",
  ],
  [
    "The environment variable WIKIFACT_TRANSPORT selects the transport of the question calls.",
    "I read the EnvVar enum in src/domain/enums.ts and the transport selection in src/updates/questions.",
  ],
  ["The tool listWikis is annotated read-only.", "I read the tool annotations paragraph of docs/technical/wikis.md."],
  [
    "The tool createWiki is annotated idempotent and not destructive.",
    "I read the tool annotations paragraph of docs/technical/wikis.md.",
  ],
  [
    "The tool archiveWiki is annotated destructive.",
    "I read the tool annotations paragraph of docs/technical/wikis.md.",
  ],
  [
    "When several archives share a name, unarchiveWiki restores the newest and says so in its answer.",
    "I read the unarchiveWiki row in docs/technical/wikis.md.",
  ],
  [
    "The question Q4 runs on opus with high effort in the question tests.",
    "I read the results table of docs/technical/questions.md: Q4 is opus, high.",
  ],
  [
    "The question Q12 runs on sonnet with low effort in the question tests.",
    "I read the results table of docs/technical/questions.md: Q12 is sonnet, low.",
  ],
  [
    "The file docs/future.md holds the ideas that have no plan, each with its trigger.",
    "I read section 1 of CLAUDE.md.",
  ],
  ["The folder docs/research/ holds the notes of measurements.", "I read section 1 of CLAUDE.md."],
  [
    "The first log line of serve and of worker names the mode, the transport and the condition.",
    "I read the Local mode section of docs/technical/deployment.md.",
  ],
  [
    "WikiFact loads .env files through the dotenv library.",
    "I read the dependencies in package.json and the first lines of src/env.ts.",
  ],
  [
    "Each model call writes a row in the model_calls table.",
    "I read the Model call rows section of docs/technical/updates.md: the worker writes 1 row for each call.",
  ],
  [
    "Step 1 of the pipeline is the claim check and the gathering of the facts around the claim.",
    "I read the heading of Step 1 in docs/technical/updates.md.",
  ],
  [
    "The project runs on Windows only.",
    "I read section 6 of docs/code-standard.md: off win32 the check fails at once with a message.",
  ],
  [
    "The typecheck of npm run check runs tsc with the incremental option.",
    "I read section 6 of docs/code-standard.md, on the typecheck.",
  ],
  [
    "The command npm run clean-temp deletes the run folders of test runs that were stopped.",
    "I read section 8 of docs/code-standard.md, last bullet, on clean-temp.",
  ],
  [
    "Application code and the evals delete their own temp folders.",
    "I read section 8 of docs/code-standard.md, last bullet.",
  ],
  [
    "The check lock of npm run check is named after the hash of the common git folder.",
    "I read section 6 of docs/code-standard.md: the name is wikifact-check- and 16 hex of the sha256.",
  ],
  [
    "The command npm run eval:bulk-wiki builds the wiki of the bulk test under the .cache folder of the repo.",
    "I read the eval:bulk-wiki row in the Develop section of README.md.",
  ],
  [
    "The command npm run clean-temp prints the counts of the folders it deleted.",
    "I read the clean-temp row in the Develop section of README.md.",
  ],
];

/** Claims that a seed fact holds, in other words. */
export const DUPLICATES: Entry[] = [
  ["The database driver of WikiFact is better-sqlite3.", "I read the dependencies in package.json.", "Database driver"],
  [
    "Node.js 22 is the oldest version that WikiFact runs on.",
    "I read the engines field in package.json.",
    "Runtime version",
  ],
  ["A wiki is stored as a single SQLite file.", "I read assumption A2 in docs/technical/README.md.", "Wiki file"],
  ["Facts get ULIDs as ids.", "I read the facts table in docs/technical/storage.md.", "Fact ids"],
  [
    "The update pipeline has nine steps.",
    "I read the Pipeline section of docs/technical/updates.md.",
    "Pipeline length",
  ],
  ["One worker process serves each database.", "I read assumption A3 in docs/technical/README.md.", "Worker count"],
  [
    "The default embedding model is bge-small-en-v1.5 from Xenova.",
    "I read open setting O4 in docs/technical/README.md.",
    "Embedding model",
  ],
  ["The service uses port 7777.", "I read the Service mode section of docs/technical/deployment.md.", "Service port"],
  [
    "A batch of the high volume mode holds up to 100 requests by default.",
    "I read DEFAULT_BATCH_SIZE in src/config/schema.ts.",
    "Batch size",
  ],
  [
    "The high volume mode begins on its own when 10 submissions are queued.",
    "I read DEFAULT_HIGH_VOLUME_MIN in src/config/schema.ts.",
    "High volume threshold",
  ],
  [
    "The dependencies of WikiFact are installed with npm ci and the flag --ignore-scripts.",
    "I read the Install and run section of docs/technical/deployment.md.",
    "Install command",
  ],
  ["Q3 writes the merged version of two facts.", "I read the table of questions in docs/technical/updates.md.", "Q3"],
  [
    "A queued request is a submission, a lookupRepair, an operatorEdit or a cleanupRepair.",
    "I read the RequestKind enum in src/domain/enums.ts.",
    "Request kinds",
  ],
  [
    "In local mode, serve --http listens on the loopback address 127.0.0.1 only.",
    "I read the Local mode section of docs/technical/deployment.md.",
    "Local mode binding",
  ],
  [
    "The bulk test never writes to its source copy.",
    "I read the usage comment at the top of eval/bulk.ts.",
    "Bulk test source",
  ],
  ["Only the code in src/store/ is allowed to run SQL.", "I read section 2 of docs/code-standard.md.", "SQL rule"],
  [
    "The SQLite database of a wiki runs with the WAL journal.",
    "I read the Tables section of docs/technical/storage.md.",
    "Journal mode",
  ],
  [
    "npm run ship stops when the current branch is not build.",
    "I read the Ship a release section of docs/technical/release.md.",
    "Ship branch",
  ],
];

/** True corrections: each replaces the value of a seed fact that is out of date on purpose (`OUT_OF_DATE` in the seed). */
export const CORRECTIONS: Entry[] = [
  [
    "The search tool returns at most 10 results by default.",
    "I read DEFAULT_SEARCH_CAP = 10 in src/store/types/config.ts, the default of the searchCap key of wikifact.json.",
    "Search result cap",
  ],
  [
    "A question call times out after 120 seconds by default.",
    "I read DEFAULT_QUESTION_TIMEOUT_S = 120 in src/config/schema.ts, the default of the questionTimeout key.",
    "Question timeout",
  ],
  [
    "The default concurrency of a batch is 4 groups at the same time.",
    "I read DEFAULT_BATCH_CONCURRENCY = 4 in src/config/schema.ts, the default of highVolume.concurrency.",
    "Batch concurrency",
  ],
  [
    "The cleanup queues at most 20 requests per finder per run.",
    "I read CLEANUP_CAP = 20 in src/store/cleanup/limits.ts and the When it runs paragraph of docs/technical/cleanup.md.",
    "Cleanup cap",
  ],
  [
    "A live tag with more than 15 live facts is a broad tag candidate.",
    "I read BROAD_TAG_FACTS (15) in the limits of the cleanup.",
    "Broad tag size",
  ],
];

/** False claims whose justification is a weak observation (an older draft, a model card of another model), weaker than the justification of the seed fact they disagree with; never hearsay or a belief. */
export const CONTRADICTED: Entry[] = [
  [
    "The service listens on port 8080.",
    "I read in an older draft of the deployment notes that the port is 8080.",
    "Service port",
  ],
  [
    "The default embedding model gives vectors of 768 dimensions.",
    "I read the model card of bge-base-en-v1.5, which has 768 dimensions.",
    "Embedding dimensions",
  ],
  [
    "W_READ, the weight of a read in the confidence score, is 0.5.",
    "I read an older draft of docs/technical/README.md that set W_READ to 0.5.",
    "Read weight",
  ],
  [
    "USE_BOUND, the bound of the usefulness multiplier, is 0.2.",
    "I read an older draft of docs/technical/README.md that set it to 0.2.",
    "Usefulness bound",
  ],
  [
    "The default quality preset is premium.",
    "I read an older draft of docs/technical/README.md that gave premium as the default quality.",
    "Default quality",
  ],
  [
    "The update pipeline is a chain of 8 steps.",
    "I counted the steps in an older draft of docs/technical/updates.md and found 8.",
    "Pipeline length",
  ],
  [
    "A cache read costs 0.25 times the input price.",
    "I read an older draft of config/prices.json that set the cache read factor to 0.25.",
    "Cache read price",
  ],
];

/** Submissions with 2 or 3 distinct claims each. */
export const COMPOUND: Entry[] = [
  [
    "The tool listWikis is annotated read-only, and the question Q12 runs on sonnet with low effort, and npm run clean-temp deletes only folders older than 1 hour.",
    "I read docs/technical/wikis.md, docs/technical/questions.md and README.md.",
  ],
  [
    "The typecheck of npm run check runs tsc with the incremental option, and WikiFact loads .env files through dotenv.",
    "I read section 6 of docs/code-standard.md and the first lines of src/env.ts.",
  ],
  [
    "The file docs/future.md holds the ideas that have no plan, and the folder docs/research/ holds the notes of measurements, and the project runs on Windows only.",
    "I read CLAUDE.md and section 6 of docs/code-standard.md.",
  ],
  [
    "An index file holds no logic, and the typecheck keeps its cache in .cache/, and archiveWiki is annotated destructive.",
    "I read section 2 and section 6 of docs/code-standard.md and docs/technical/wikis.md.",
  ],
  [
    "The command npm run demo:seed creates a demo wiki with 10 facts, and the command npm test runs the unit tests alone.",
    "I read scripts/seed-demo.ts and the Develop section of README.md.",
  ],
  [
    "Each model call writes a row in model_calls, and the environment variable WIKIFACT_TRANSPORT selects the transport, and Q4 runs on opus.",
    "I read docs/technical/updates.md, src/domain/enums.ts and docs/technical/questions.md.",
  ],
  [
    "Lint has no cache, and a switch over an enum has no default branch, and an object type is an interface.",
    "I read sections 1, 4 and 6 of docs/code-standard.md.",
  ],
  [
    "The first log line of serve names the mode, and unarchiveWiki restores the newest of several archives, and package-lock.json pins each version.",
    "I read docs/technical/deployment.md, docs/technical/wikis.md and section 5 of docs/code-standard.md.",
  ],
];

/**
 * False claims against a seed fact whose justification is hearsay (someone told the submitter): a `report`, which step 1
 * lets through. Q4 weighs it against the strong justification of the seed fact, so each ends as rejected contradicted.
 * Each names the seed fact that states the true value of its scope.
 */
export const HEARSAY: Entry[] = [
  [
    "The query of search can be up to 4,000 tokens long.",
    "A colleague told me that the limit is much higher.",
    "Search query limit",
  ],
  [
    "The search tool uses a cloud embedding service.",
    "Someone said that the vectors come from an API.",
    "Embedding location",
  ],
  [
    "A finder of the cleanup deletes the empty tags.",
    "I heard it from another agent, I have no source.",
    "Empty tag deletion",
  ],
];

/** Claims without evidence: the justification is a belief or an inference, with no observation. */
export const UNSUPPORTED: UnsupportedEntry[] = [
  [
    "WikiFact will move from SQLite to Postgres in the next release.",
    "I think I read that somewhere.",
    JustificationKind.Belief,
  ],
  ["Most agents never call getTag.", "It seems likely to me.", JustificationKind.Belief],
  [
    "WikiFact supports the Gemini models for its questions.",
    "It would make sense, so I assume it does.",
    JustificationKind.Inference,
  ],
  [
    "The service runs on Linux as well as on Windows.",
    "Node.js runs everywhere, so it should work.",
    JustificationKind.Inference,
  ],
  [
    "The update worker uses more than 8 GB of memory.",
    "I guess so, because it runs a model.",
    JustificationKind.Belief,
  ],
  ["The high volume mode makes the answers worse.", "I feel that batches lose detail.", JustificationKind.Belief],
  ["Every wiki needs an API key to be read.", "I believe consumers must log in.", JustificationKind.Belief],
  [
    "The console is slow with more than a thousand facts.",
    "I suspect it, but I did not try.",
    JustificationKind.Belief,
  ],
  [
    "Deleting a fact removes its versions from the database.",
    "That is how deletion usually works.",
    JustificationKind.Inference,
  ],
];

/**
 * 6 groups on 6 new subjects, each `[name, members, winner?]`. 3 state one claim in other words. 3 hold values that
 * conflict: the first member is true and has a strong observation (a constant or a direct observation), each later
 * member is false and has a weak observation (an older draft), and `winner` is the value that the kept fact must hold.
 */
export const GROUP_CLAIMS: [name: string, members: Member[], winner?: string][] = [
  [
    "clean-temp-not-in-check",
    [
      [
        "The command npm run clean-temp is never run by npm run check.",
        "I read the header comment of scripts/clean-temp.ts.",
      ],
      [
        "npm run check does not call clean-temp.",
        "I read check:steps in package.json: clean-temp is not among the steps.",
      ],
      [
        "Cleaning the temp folders is a step that the operator takes by hand, never one that npm run check starts.",
        "I read the clean-temp row of the table of scripts in README.md: it runs by hand.",
      ],
    ],
  ],
  [
    "steps-record",
    [
      [
        "While the steps of npm run check run, the file wikifact-check-steps.json in the common git folder holds their pid.",
        "I read section 6 of docs/code-standard.md, on the record of the steps.",
      ],
      [
        "npm run check writes the pid of its steps to wikifact-check-steps.json for as long as they run.",
        "I read section 6 of docs/code-standard.md.",
      ],
    ],
  ],
  [
    "lint-cache",
    [
      [
        "The lint step of npm run check runs without a cache.",
        "I read section 6 of docs/code-standard.md: Lint has no cache.",
      ],
      [
        "ESLint keeps no cache in the check, because its type-checked rules read other files.",
        "I read section 6 of docs/code-standard.md, on the lint step.",
      ],
      [
        "A cache for ESLint would miss an error that a change in another file causes, so the repo uses none.",
        "I read section 6 of docs/code-standard.md, on the lint step.",
      ],
    ],
  ],
  [
    "check-retry",
    [
      [
        "A check that finds the lock held prints a waiting message and tries again every 3 seconds.",
        "I read POLL_MS = 3000 in scripts/check.ts and section 6 of docs/code-standard.md.",
      ],
      [
        "A check that finds the lock held tries again every 10 seconds.",
        "I read an older draft of section 6 of docs/code-standard.md that gave 10 seconds.",
      ],
    ],
    "3 seconds",
  ],
  [
    "clean-temp-age",
    [
      [
        "The command npm run clean-temp deletes only the temp folders that are older than 1 hour.",
        "I read DEFAULT_MIN_AGE_MS = 60 * 60 * 1000 in scripts/clean-temp.ts and the clean-temp row in README.md.",
      ],
      [
        "The command npm run clean-temp deletes only the temp folders that are older than 24 hours.",
        "I read an older draft of the clean-temp row in README.md.",
      ],
    ],
    "1 hour",
  ],
  [
    "cache-folder",
    [
      [
        "The caches of the typecheck and of the format check live in the .cache folder.",
        "I read section 6 of docs/code-standard.md and the typecheck and check:format scripts in package.json.",
      ],
      [
        "The caches of the typecheck and of the format check live in the .logs folder.",
        "I read an older draft of section 6 of docs/code-standard.md that put the caches in .logs.",
      ],
    ],
    ".cache",
  ],
];
