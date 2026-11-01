// The seed facts of the bulk test wiki (technical/updates.md, "The wiki of the bulk test"): facts about the WikiFact code
// base, each from one sentence of the docs of this repo, each 1 claim. `npm run eval:bulk-wiki` writes them straight into
// the wiki, with their embeddings. Never edit a fact to make a run pass: a submission that targets one names it by header. 5 facts are out of date on
// purpose (the marker OUT_OF_DATE): the corrections of bulk-submissions.ts give their true values.

/** One seed fact. */
export interface SeedFact {
  header: string;
  content: string;
  /** The doc that holds the claim. */
  justification: string;
  /** True when the value is wrong today on purpose: a correction submission targets this fact. */
  outOfDate: boolean;
}

/** Marks a seed fact whose value is out of date on purpose, so that a correction in `bulk-submissions.ts` has a target. */
const OUT_OF_DATE = true;

/** The facts of one subject: the doc they come from, and the `[header, content]` pairs. */
interface Group {
  doc: string;
  facts: [header: string, content: string, outOfDate?: typeof OUT_OF_DATE][];
}

const GROUPS: Group[] = [
  {
    doc: "docs/technical/README.md, Stack and assumptions; package.json",
    facts: [
      ["Runtime version", "WikiFact requires Node.js 22 or newer."],
      ["Source language", "The source code of WikiFact is TypeScript."],
      ["Database driver", "WikiFact reads and writes SQLite through the better-sqlite3 library."],
      ["Wiki file", "One wiki is one SQLite file."],
      ["SQLite vector extension", "The sqlite-vec extension holds the vector index of a wiki."],
      ["SQLite text index", "SQLite FTS5 holds the full-text index of a wiki."],
      ["MCP SDK", "The MCP server uses the @modelcontextprotocol/sdk package."],
      ["Model SDK", "The SDK transport calls Claude through the @anthropic-ai/sdk package."],
      ["Test runner", "The unit tests run on vitest."],
      ["Embedding location", "The embedding model runs in-process, so retrieval works offline."],
      ["Update agent kind", "The update agent is deterministic code that calls Claude for narrow questions only."],
    ],
  },
  {
    doc: "docs/technical/storage.md",
    facts: [
      ["Journal mode", "The database of a wiki is SQLite in WAL mode."],
      ["Write connection owner", "The worker process owns the write connection for the wiki."],
      ["Fact ids", "A fact id is a ULID."],
      ["Change sequence", "The changes table numbers every change with a global sequence number."],
      ["Change outcomes", "The outcome of a change is accepted, duplicate, rejected or split."],
      ["Fact versions", "A fact is never overwritten: each edit writes a new row in the fact_versions table."],
      ["Version justification", "Each fact version stores the justification of the request that wrote it."],
      ["Staging tables", "The staging tables of the high volume mode are named with the prefix stg_."],
      ["Change request table", "The change_requests table is the queue of the update worker."],
      ["Index maintenance", "The index tables are kept in step with fact_versions inside the write transaction."],
      ["Reindex command", "The command wikifact reindex rebuilds the index tables and embeds everything again."],
    ],
  },
  {
    doc: "docs/technical/lookup.md",
    facts: [
      ["Search input", "The search tool takes one string, the query."],
      ["Search query style", "A search query is a phrase of terms or a claim as a fact would read, not a question."],
      [
        "Search query limit",
        "A query longer than 512 tokens, the input window of the embedding model, is rejected with an error that states the limit.",
      ],
      ["Search result cap", "The search tool returns at most 20 results by default.", OUT_OF_DATE],
      ["Search result kinds", "A search result is either a fact or a tag."],
      ["Search id", "Each search returns a searchId, a ULID, that requestChange can take."],
      [
        "Result note",
        "A search result carries a note that asks the consumer to send what the wiki lacks with requestChange.",
      ],
      ["Always-loaded tools", "The tools search, getFact and requestChange carry the anthropic/alwaysLoad meta key."],
      ["Retrieval hybrid", "Search combines a full-text rank and a vector rank."],
      ["Vector candidates", "The vector search takes 100 candidates before the rescore."],
      ["Embedding dimensions", "The default embedding model gives vectors of 384 dimensions."],
      ["Embedding model", "The default embedding model is Xenova/bge-small-en-v1.5."],
      ["Confirm weight", "W_CONFIRM, the weight of a confirmation in the confidence score, is 1.0."],
      ["Update weight", "W_UPDATE, the weight of an update in the confidence score, is 1.0."],
      ["Read weight", "W_READ, the weight of a read in the confidence score, is 0."],
      ["Usefulness weight", "W_USE, the weight of usefulness in the rank, is 0.01."],
      ["Usefulness bound", "USE_BOUND, the bound of the usefulness multiplier, is 0.1."],
    ],
  },
  {
    doc: "docs/technical/submit.md; docs/technical/updates.md, Consumer correction duty",
    facts: [
      ["requestChange fields", "requestChange takes a change and a justification as free text."],
      ["requestChange target", "requestChange needs no target fact."],
      ["requestChange return", "requestChange inserts a queue row and returns at once."],
      ["Submitter does not write facts", "The submitter of a change does not write the fact."],
      ["One claim per request", "A request should hold one claim."],
      ["Compound split", "A compound submission is split into one child submission for each claim."],
      ["Split children", "The children of a split carry the id of the parent submission as parent_id."],
      ["Split minimum", "A submission splits only when its claim check finds 2 or more claims."],
      ["getRequest purpose", "getRequest returns the state of a request by its id."],
      [
        "Correction levers",
        "The levers of the correction duty are the tool descriptions, the cost of a correction and the result size.",
      ],
      ["Stop hook", "The eval harness includes an example stop hook for Claude Code that asks for corrections."],
    ],
  },
  {
    doc: "docs/technical/updates.md, Pipeline",
    facts: [
      ["Pipeline length", "The update pipeline is a chain of 9 steps."],
      [
        "Step 3 condition",
        "Step 3 of the pipeline, the merge, runs only when step 2 finds 2 or more live facts in the scope.",
      ],
      ["Step 3 commit", "The merge of step 3 commits at once."],
      ["Step 9", "Step 9 of the pipeline checks the prior query of the search that the request followed."],
      ["Step 9 timing", "Step 9 runs after the commit and may queue a second request."],
      ["Question calls", "Each model question is one call with a fixed prompt and a structured output."],
      ["Q1", "Q1 asks which candidates share the scope of the claim."],
      ["Q2", "Q2 asks which of 2 live facts in one scope has the content that stands."],
      ["Q3", "Q3 writes the merged version of 2 facts."],
      ["Q4", "Q4 asks whether the claim is supported and how it relates to the existing fact in its scope."],
      ["Q5", "Q5 writes the fact version of the claim."],
      [
        "Q7",
        "Q7 asks whether a submission is one claim that a reader can act on alone, and what kind of support its justification gives.",
      ],
      ["Q8", "Q8 asks whether a dependent fact still holds."],
      ["Drafting count", "Every drafting question returns exactly 1 draft."],
      ["Q4 relations", "Q4 relates a claim to the existing fact as same, different, unrelated, negates or stale."],
      ["Reject reasons", "A rejected change has the reason unsupported, contradicted or compound."],
      ["Support kinds", "The support of a justification is an observation, a report or a belief."],
      [
        "Evidence rule",
        "A justification that a submitter sent counts as evidence in the judgment questions Q2 and Q4.",
      ],
      ["Duplicate outcome", "A claim that Q4 reads as the same as an existing fact gets the outcome duplicate."],
      ["Duplicate confirm", "A duplicate outcome records a confirmation of the existing fact."],
      [
        "Check before expensive step",
        "In the pipeline, a check that depends on no other step runs before any expensive step.",
      ],
      ["Input fault", "A fault in the input of the pipeline is a rejection with a reason, not a retried attempt."],
    ],
  },
  {
    doc: "docs/technical/updates.md, Queue and worker; docs/technical/deployment.md",
    facts: [
      ["Request kinds", "A request in the queue is a submission, a lookupRepair, an operatorEdit or a cleanupRepair."],
      ["Request statuses", "A queued request has the status queued, running, done or failed."],
      ["Worker count", "One update worker runs for each database."],
      ["Worker lock", "The worker takes the file game.sqlite.lock with an exclusive open at start."],
      ["Second worker", "A second worker on the same file exits with a message."],
      ["Worker order", "The worker takes one request at a time, the oldest first."],
      ["Queued while no worker", "A request queued while no worker runs waits in the queue."],
      ["Running request restart", "At the next start of the worker, a running row goes back to queued."],
      ["Worker command", "The command wikifact worker starts the update worker."],
      ["Requeue command", "The command wikifact requeue lists the failed requests or puts one back in the queue."],
      ["Rate limit pause", "A rate limit from the model pauses the queue and keeps the request."],
      ["Question timeout", "A question call times out after 60 seconds by default.", OUT_OF_DATE],
    ],
  },
  {
    doc: "docs/technical/updates.md, High volume mode; src/config/schema.ts",
    facts: [
      ["High volume threshold", "The high volume mode starts by itself at 10 queued submissions by default."],
      ["High volume threshold source", "The threshold of 10 queued submissions comes from the test of both paths."],
      ["Batch size", "A batch of the high volume mode takes at most 100 requests by default."],
      ["Batch concurrency", "The default concurrency of a batch is 8 groups at the same time.", OUT_OF_DATE],
      ["Operator key", "The operator can turn the high volume mode on by hand."],
      ["Batch staging", "A batch writes its changes into the staging tables first."],
      ["Batch promotion", "The promotion copies the staged changes of a batch into the live tables."],
      ["Stale check", "A batch checks that the live facts it read have not changed before it promotes."],
      ["Batch reconciliation", "A batch reconciles the facts that two requests of the batch changed."],
      ["Batch config key", "The highVolume key of wikifact.json sets min, batchSize and concurrency."],
    ],
  },
  {
    doc: "docs/technical/updates.md, The test of both paths; eval/bulk.ts",
    facts: [
      ["Bulk test command", "The command npm run eval:bulk runs the test of both paths."],
      ["Bulk test inputs", "The bulk test takes --db for the source copy and --requests for the sample size."],
      ["Bulk test paths", "The bulk test runs the same submissions one at a time and as batches."],
      ["Bulk test copies", "The bulk test runs each path on its own copy of the source."],
      ["Bulk test source", "The bulk test never writes the source copy."],
      ["Bulk test sample", "The bulk test takes the first n queued submissions of the copy."],
      [
        "Bulk test stub mode",
        "The bulk test option --stub runs the harness with stub questions and the fake embedder.",
      ],
      ["Bulk test result file", "The bulk test writes a result file that it rewrites after each request or batch."],
      ["Bulk test resume", "The bulk test option --resume continues a stopped run on its kept copies."],
      ["Bulk test rate limit", "A rate limit stops the bulk test and keeps the rows."],
      ["Bulk test duplicates", "The bulk test lists the duplicate pairs of the live facts after each path."],
      ["Bulk test sizes", "The bulk test runs at sizes on orders of magnitude: 10, 100 and 1,000 requests."],
    ],
  },
  {
    doc: "docs/technical/deployment.md, Install and run; src/config/schema.ts; config/prices.json",
    facts: [
      ["Config file", "The file wikifact.json sits next to the database of the wiki."],
      ["Config mode key", "The mode key of wikifact.json is deployed or local."],
      ["Default mode", "The default mode is deployed."],
      ["Default quality", "The default quality preset is standard."],
      ["Quality presets", "The quality presets are budget, standard and premium."],
      ["Config search cap", "The searchCap key of wikifact.json sets the result cap of search."],
      ["Missing keys", "A key that wikifact.json lacks takes its default."],
      ["Presets file", "The file config/presets.json holds the default model settings per quality."],
      ["Prices file", "The file config/prices.json holds the price of each model in USD per million tokens."],
      ["Cache read price", "A cache read costs 0.1 times the input price."],
      ["Unpriced model", "A model that is not in the price table is counted at 0 and reported as unpriced."],
      [
        "Sonnet 5.5 price",
        "The model claude-sonnet-5-5 costs 2 USD per million input tokens and 10 USD per million output tokens.",
      ],
      [
        "Opus 5.5 price",
        "The model claude-opus-5-5 costs 4 USD per million input tokens and 20 USD per million output tokens.",
      ],
      ["Transports", "A question call goes through the sdk transport or the cli transport."],
      ["CLI transport use", "The CLI transport is for local development and the evals only."],
      [
        "CLI transport temp folders",
        "Each call of the CLI transport makes 2 temp folders and deletes both when claude -p ends.",
      ],
    ],
  },
  {
    doc: "docs/technical/deployment.md; docs/technical/wikis.md; docs/technical/release.md",
    facts: [
      ["Install command", "WikiFact installs with npm ci --ignore-scripts."],
      ["Default wiki", "The default wiki is the demo wiki at wikis/demo."],
      ["Default database path", "The --db option defaults to ./wikis/demo/game.sqlite."],
      ["Model cache", "The model cache .cache/ stays at the repo root."],
      ["Serve command", "The command wikifact serve starts the MCP server."],
      ["Serve transport", "The MCP server uses the stdio transport by default."],
      ["Serve http option", "The option --http PORT serves the MCP server over HTTP."],
      ["Server never runs worker", "The MCP server does not run the worker unless --with-worker is given."],
      ["Local mode user", "Local mode is for one user, one account and one machine."],
      ["Local mode credentials", "In local mode the worker uses the CLI transport without an API key."],
      ["Local mode binding", "In local mode, serve --http binds to 127.0.0.1 only."],
      ["Key wins", "When an API key is set, the SDK transport wins in every mode."],
      ["Service port", "The service listens on port 7777."],
      ["Service command", "The service runs wikifact serve --wikis ./wikis --http 7777 --with-worker."],
      ["Service task", "The scheduled task WikiFact starts the service at each logon of the user."],
      ["Worker per wiki", "The service starts one worker child for each wiki, each under its own lock file."],
      [
        "Env file lookup",
        "The .env file is looked up next to the database first, then at the wikis root, then at the project root.",
      ],
      ["Max wikis", "The service mounts at most 10 wikis by default, set by --max-wikis."],
      ["Empty wiki archive", "archiveWiki removes a wiki that has no fact and no queued request."],
      ["Management endpoint", "The management endpoint of the service is http://127.0.0.1:7777/mcp."],
      ["Ship command", "The command npm run ship makes the release and the deploy in one command."],
      ["Ship branch", "npm run ship refuses a branch other than build."],
      ["Ship check", "npm run ship runs npm run check once."],
      ["Deploy command", "The command npm run deploy is for a redeploy and refuses a HEAD that is not a release tag."],
    ],
  },
  {
    doc: "docs/technical/console.md",
    facts: [
      ["Console path", "The operator console is served under /console/ of the service."],
      [
        "No read share",
        "The console rates the reads per search of a wiki as poor when the share of searches with 0 reads is over 0.5.",
      ],
      [
        "Many reads share",
        "The console rates the reads per search of a wiki as poor when the share of searches with 3 or more reads is over 0.3.",
      ],
      ["Read signals constants", "NO_READ_SHARE and MANY_READS_SHARE are first guesses."],
      [
        "Console pages",
        "The console has the pages Wikis, Overview, Service health, Jobs, Data, Search, Fact, Tags, Tag, Requests, Request and Settings.",
      ],
      ["Console health levels", "A health signal in the console is ok, warning or failing."],
      ["Operator edit", "An operator edit of a fact goes through the queue as an operatorEdit request."],
      ["Console tests", "A console page test parses the page with jsdom."],
      ["Console browser test", "The browser test of the console runs in a headless Edge or Chrome."],
      ["Console shots", "The command npm run console:shots writes one 1440 px PNG per console page."],
    ],
  },
  {
    doc: "docs/technical/cleanup.md; docs/technical/README.md, Open settings",
    facts: [
      ["Cleanup cap", "The cleanup queues at most 50 requests per finder per run.", OUT_OF_DATE],
      ["Missing tag start", "The missing tag finder starts at an interval of 20 writes, which changes after each run."],
      ["Broad tag start", "The broad tag finder starts at an interval of 100 writes, which changes after each run."],
      [
        "Duplicate tag start",
        "The duplicate tag finder starts at an interval of 200 writes, which changes after each run.",
      ],
      ["Broad tag size", "A live tag with more than 25 live facts is a broad tag candidate.", OUT_OF_DATE],
      ["Nearest tags", "The duplicate tag finder compares each tag with its 3 nearest tags."],
      ["Nearest facts per tag", "The missing tag finder looks at the 10 nearest facts of each tag."],
      ["Tags per fact", "The missing tag finder proposes at most 5 tags per fact."],
      ["Cleanup trigger", "The cleanup runs when the queue is empty."],
      ["Tag repair request", "A cleanup repair is queued as a cleanupRepair request."],
      ["Q11", "Q11 asks which facts lack a tag they belong under."],
      ["Q12", "Q12 asks whether two tags are one topic."],
      ["Q11B", "Q11B is the batch prompt for the missing-tag candidates."],
      ["Empty tag", "A tag with no live fact is an empty tag."],
      ["Empty tag deletion", "The write that empties a tag deletes it; no finder of the cleanup does."],
    ],
  },
  {
    doc: "docs/technical/evaluation.md; README.md, Develop",
    facts: [
      ["Evals command", "The command npm run eval:all runs every eval in one order."],
      ["Questions command", "The command npm run eval:questions runs the question sets."],
      ["Relevance eval", "The relevance eval measures the ranking of search."],
      ["Replay test", "The replay test runs the pipeline on scripted cases against a seed wiki."],
      ["Corrections test", "The correction test measures how often a consumer sends a correction."],
      [
        "Benefit test",
        "The benefit test runs the same repo questions through two Claude Code agents, with and without the wiki tools.",
      ],
      ["Eval server source", "An eval entry point spawns a server from source, never from dist/."],
      ["Eval result files", "An eval writes a timestamped result file and flushes partial results during the run."],
      ["Fake embedder", "The fake embedder gives a deterministic bag of hashed words as a vector."],
      ["Fakes folder", "The fakes folder holds the stubs and fakes that the unit tests and the stub modes share."],
    ],
  },
  {
    doc: "docs/code-standard.md",
    facts: [
      ["Check command", "The command npm run check is the gate before a commit."],
      ["Check lock", "npm run check takes a lock so only one check runs at a time over all worktrees of the repo."],
      ["Check lock kind", "The check lock is a named pipe that the OS frees when the process ends."],
      [
        "Check steps",
        "The check runs the typecheck, lint, format check, requirement check, standard check, dead code check, unit tests and the browser test.",
      ],
      ["Dead code tool", "The dead code check uses knip."],
      ["Format tool", "The formatting of the repo is Prettier."],
      ["Lint tool", "The lint of the repo is ESLint with typescript-eslint and eslint-plugin-jsdoc."],
      ["Enum rule", "A fixed set of names is a TypeScript enum with string values."],
      ["Enum home", "The enums of src/ live in src/domain/enums.ts."],
      ["Eval enum home", "The enums that only eval/, scripts/ or .claude/scripts/ use live in eval/lib/enums.ts."],
      ["SQL rule", "Only src/store/ runs SQL."],
      ["Import rule", "src/ never imports from eval/, fakes/ or a __tests__ folder."],
      ["Positional parameters", "A function has at most 4 positional parameters."],
      ["No any", "The code uses no any type."],
      [
        "JSDoc rule",
        "A JSDoc block has a param tag for every parameter, a returns tag only for a return value, a throws tag only when the function throws, and a sideEffects tag on every function.",
      ],
      ["Test location", "A unit test lives in the __tests__ folder of the module it tests."],
      [
        "Requirement tests",
        "A requirement test lives in __tests__/requirements/ and carries the name of its requirement.",
      ],
      ["Test clock", "A test reads no wall clock."],
      ["Test temp folder", "A test run uses one temp folder of its own."],
      ["File size sign", "A file over 400 lines is a sign that it has 2 concerns."],
      ["Docs layers", "The docs have 3 layers: requirements, design and technical."],
      ["Decision records", "A decision gets a record in docs/decisions/."],
    ],
  },
];

/** The seed facts of the bulk test wiki, in order. */
export const SEED_FACTS: SeedFact[] = GROUPS.flatMap((g) =>
  g.facts.map(([header, content, outOfDate]) => ({
    header,
    content,
    justification: `Read in ${g.doc}.`,
    outOfDate: outOfDate === OUT_OF_DATE,
  })),
);
