# Publication

Technical layer. The requirements are in [../requirements/publication.md](../requirements/publication.md). The design is in [../design/publication.md](../design/publication.md).

## The export command

- `npm run export:public -- <target>` runs `scripts/export-public.ts`. `<target>` is a local clone of the public repo. The command refuses a dirty tree, a branch other than `build`, and a `<target>` that is not the top folder of a git repo, that is the source repo, or that has uncommitted changes. The source repo is refused in every form: the same real path (compared in lower case on Windows), a folder inside the source or holding it, and a worktree or clone that shares its git common folder (`git rev-parse --path-format=absolute --git-common-dir`). The command never pushes. It builds the whole public tree in a temp folder and scans it before it touches `<target>`, so a stop or a fault of the build leaves `<target>` as it was. When the tree equals the last commit of `<target>`, it makes no commit.
- The source files are the output of `git ls-files` at `HEAD`, without the excluded paths of `publication/export.json`. After the scan the export deletes each file of `<target>` except `.git/`, copies the public tree from the temp folder, then commits with `git add -A` and the message `WikiFact v<version>`. A write fault after the delete can leave a partial tree in `<target>`; the next run refuses it as a dirty target. The author and the committer of the commit are what `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` give in `<target>`, with the environment of the command.
- `publication/README.md` is written as `README.md`, and `publication/export.json` is copied to the same path. The public `package.json` has no `private` field.
- A copied file that is not valid UTF-8 stops the export, unless its path matches a pattern of `binaryAllow`.

## publication/export.json

| Key | Holds |
|---|---|
| `exclude` | Paths and folder prefixes that the export leaves out: `CLAUDE.md`, `.claude/`, `.github/ISSUE_TEMPLATE/`, `.worktreeinclude`, `reports/`, `publication/`, `README.md`, `wikis/demo/` (the demo wiki has no DB; the export builds `wikis/wikifact/`), `docs/decisions/`. |
| `binaryAllow` | Glob patterns (`path.posix.matchesGlob`) of the files that may be binary, that is, not valid UTF-8. The scan reads each of them as latin1 and as UTF-16LE (at both byte offsets). Empty today: the repo has no binary file. |
| `resultFolders` | The eval result folders: `eval/questions/results`, `eval/bulk/results`, `eval/benefit-results`, `eval/replay-results`, `eval/corrections/results`, `eval/relevance-results`, `eval/rebuild-results`, `eval/reads-per-search-results`, `eval/results`, `eval/speed-results`. |
| `demo` | `source`: the live store (default `~/wikifact/wikis/wikifact/game.sqlite`; a leading `~/` is the home folder). `config`: the keys that the `wikifact.json` of the copy gets: `mode`, which is `deployed`. |

`export.json` and `publication/README.md` are the 2 files of `publication/` that the export reads. `publication/` itself is not copied, but `README.md` is copied under its new name and `export.json` at its own path.

## Eval result files

In each folder of `resultFolders`, the export keeps:

1. The newest file of the folder whose name is a time stamp (`<ISO stamp>.json`, with `:` and `.` as `-`), and the newest `summary-<stamp>.json` of the folder. The order is the order of the names.
2. Each file whose file name occurs in an exported text file, including `config/presets.json`. A name inside a longer name does not count: `summary-<stamp>.json` does not name `<stamp>.json`. The text files that name result files are all exported text files except the result files themselves, after the links are rewritten and the pairs applied.

A result file is a `.json` file under a folder of `resultFolders`; another file there (for example `.gitkeep`) stays.

## Links

The export parses each exported `.md` file with a CommonMark parser, `mdast-util-from-markdown` (a dev dependency), and takes the `link` and `image` nodes with their source offsets. A regular expression does not find the links: CommonMark rules decide what is code and what is a link, and a regular expression gets the edge cases wrong. The export then changes the source text only at the offsets of these nodes, so the rest of the file stays byte for byte. The export and the test "Decision citations" use the same function to find the links. When the target of a link, resolved against the folder of the file (an anchor and a query dropped), is an excluded path, the link becomes `text`, and an image becomes nothing. A target with a scheme, a pure anchor and a path outside the root stay. Text inside a code span or a code block is not a link for the parser, so the examples below stay in the public tree. A link whose text holds a code span, such as ``[`0183`](../decisions/0183-x.md)``, is a link.

A decision link is a link whose resolved target is a file `docs/decisions/<digits>-<name>.md`. A reference list is a parenthesis in the source text whose content, split at `, ` and `; `, has only items that are a link node of the parser (its whole source span) or an issue id `#<digits>`. The export removes each decision link of a reference list, with the separator next to it. When no item is left, it removes the parenthesis and the space before it. Examples:

| Before | After |
|---|---|
| `text ([decision 0183](../decisions/0183-x.md)).` | `text.` |
| `text ([decision 0164](../decisions/0164-x.md), #60).` | `text (#60).` |
| `text ([Tests](../code-standard.md#8-tests), [decision 0155](../decisions/0155-x.md)).` | `text ([Tests](../code-standard.md#8-tests)).` |

The requirement test "Decision citations" reads each markdown file of the repo outside `docs/decisions/` and the excluded paths, and fails with `<file>:<line>` for each decision link that is not in a reference list. It also reads each other exported text file, code included, except the result files of `resultFolders` (recorded model output, copied unchanged), and fails on each plain mention: the text `decision <4 digits>` or `decisions <4 digits>` (any case) that is not the text of a decision link and is not in a code span or a code block of a markdown file. In code, a comment cites the doc heading (`docs/…md#anchor`) of the rule, never a decision record.

## The plugin

| Path | Holds |
|---|---|
| `.claude-plugin/marketplace.json` | The marketplace `wikifact`, owner `Arkased`, with 1 plugin: `{ "name": "wikifact", "source": "./plugin" }`. |
| `plugin/.claude-plugin/plugin.json` | The name `wikifact`, a version, the author, the description. |
| `plugin/.mcp.json` | The server `wikifact`: `{ "type": "http", "url": "http://127.0.0.1:7777/mcp" }`, the management endpoint. |
| `plugin/hooks/hooks.json` | `SessionStart` and `SubagentStart` run `dist/wiki-context.js`. `PreToolUse` with the matcher `SubagentHandback`, and `SubagentStop`, run `dist/wiki-submit.js`. Each command is `node "${CLAUDE_PLUGIN_ROOT}/dist/<file>"`. |
| `plugin/commands/setup.md` | `/wikifact:setup [subject]`: runs `dist/setup.js`, then creates the wiki with `createWiki` when `listWikis` does not hold it. |
| `plugin/src/` | The TypeScript source of the 3 entry files and their small helpers. It imports nothing from `src/`, `eval/` or `scripts/`. |
| `plugin/dist/` | 1 self-contained CommonJS file per entry, built by esbuild with all dependencies bundled, and a `package.json` with `{ "type": "commonjs" }`. Tracked in git. |
| `plugin/README.md` | The install, the hooks and the setup, for a reader. |

`dist/setup.js` adds `mcp__plugin_wikifact_wikifact` to `permissions.allow` in `.claude/settings.json`. When `.claude/setup.config.json` has no `wiki.name`, it writes `wiki.name` as the name of the project folder in lower case, with each run of characters other than `a-z`, `0-9` and `-` as 1 `-`. The name then gets the limit of a wiki name (`WIKI_NAME_PATTERN` in `src/service/names.ts`, 1 to 40 characters): it is cut to the maximum length, and a `-` at its start or end is removed. When no character is left, the name is `wiki`. The plugin holds its own copy of the limit, because it imports nothing from `src/`; a test compares the 2 values. It keeps every other key of the file and creates the file when it is absent. It prints `written` or `unchanged`.

`npm run build` also builds `plugin/dist/`. `npm run check` fails when `plugin/dist/` differs from a fresh build. The tests of the plugin are in `__tests__/plugin/`. The npm package does not ship `plugin/`.

## Private terms

The private terms have 2 parts with 2 jobs. The scan finds each term in any spelling, and it stops the export. The pairs replace a term only in a fixed set of spellings, and they never guess. A spelling that no pair covers stays, and the scan then stops the export. So a gap in the pairs gives a false stop, never a leak.

### The terms file

`publication/private-terms.txt` is in `.gitignore`. 1 term per line; `#` starts a comment. A line `<term> => <replacement>` is a pair. A term needs a letter or a digit. The export stops when the file is missing or holds no term.

### The scan

The scan covers the spellings that tools write: the plain text, the JSON and the HTML escapes, URL encoding up to 3 rounds, the Unicode compatibility forms and accents, and the folder names of Claude Code. The texts come from the developer and the agents of the developer, not from an adversary. So the scan does not cover a text that mixes a literal `%XX` with an escape (`100%2024%20Report`), an escape of another language (`\x20`, `%u0020`), base64, or look-alike letters. The developer reads the diff of each public commit before the push.

1. The compact form of a text: NFC, lower case, and each character that is not a letter or a digit removed. A combining mark is removed after NFC, so it cannot split a letter from its word.
   The fold form of a text is the same with NFKD in place of NFC and each `\p{M}` mark removed, so `José` is `jose` and a full-width letter is its plain letter.
2. A text has these views:
   1. The text as it is.
   2. The text with each `%XX` sequence decoded. A sequence that is valid UTF-8 gives its characters; any other byte gives its latin1 character. The decode runs 3 rounds, and each round is its own view, so a term that a middle round of a multiple encoding holds is found.
   3. The text with only the `%XX` sequences decoded whose character is not a letter or a digit. So `20%4Desk%20Ltd` keeps `%4D` as the 3 characters and drops the encoded space.
   4. The text with each `%XX` sequence removed whose byte is below 0x80 and is not a letter or a digit, and every other character kept. So `50%ACME%20Corp`, a literal `%` and an encoded space, is found.
   5. The text with each JSON `\uXXXX` escape and each HTML entity (`&#105;`, `&#x69;`, and the named entities of `scripts/lib/html-entities.ts`: `amp`, `lt`, `gt`, `quot`, `apos`, the ISO 8859-1 set of HTML 4 and the Latin Extended-A letters, looked up by exact name in the `Map` `HTML_ENTITIES`) decoded, 3 rounds, each round its own view. A numeric entity needs no `;` and may have leading zeros.
   6. The text with the decode of view 2 and the decode of view 5 together in each of 3 rounds, each round its own view.
3. A term matches when its compact form occurs in the compact form of at least 1 view, or its fold form occurs in the fold form of at least 1 view. A folder name in which Claude Code turned an accented letter into `-` (`C--Users-Jos-` for `José`) is a known limit: no fold catches it. The line of a match is the line of the original text where the match starts. A line break is removed with the other separators, so a term that a line break splits is found.
4. The scan reads:
   - each exported path;
   - each exported file whose bytes are valid UTF-8 and hold no U+0000;
   - each other exported file whose path matches `binaryAllow`, as latin1 and as UTF-16LE at both byte offsets; any other such file stops the export;
   - each `TEXT` column of each table of the demo copy, the full-text index tables left out (the export rebuilds them from the scanned columns);
   - the author and the committer that `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` give in `<target>`, with the environment of the commit.
5. A match prints `<file>:<line>: <term>`, `<file> (path): <term>`, `<table>.<column> rowid <n>: <term>` or `git var <name>: <term>`, and the export exits with 1 before it touches `<target>`.

The compact form drops the word breaks, so a short term can match inside a longer word. Write each term as its longest private form: the full path or the full email, not a first name.

The table of the HTML named entities is a `Map`, so a lookup cannot read an inherited key. The line of a match comes from a binary search over the line starts. A note in `docs/research/` holds the measured time of the scan on a large text; no test reads the clock.

### The pairs

Each pair `<term> => <replacement>` has 5 spellings. The export replaces each spelling of the term, case-insensitively (the `iu` flags, on the spellings as written, so a term whose lower case is longer, like `İstanbul`, is replaced), by the same spelling of the replacement:

| Spelling | The change to the term and to the replacement |
|---|---|
| Plain | None. |
| Forward | Each `\` as `/`. |
| JSON | Each `\` as `\\`. |
| Folder name | Each character that is not an ASCII letter or digit as `-`, as Claude Code names a project folder. A term whose folder name holds no ASCII letter or digit (`李明`) has no folder spelling; its other spellings stay. |
| URL | `encodeURIComponent`, and the same with each `%2F` as `/`. |

The longest spelling is replaced first, so a JSON spelling is not cut by the plain spelling. The pairs run on each exported text file and on each `TEXT` column of the demo copy, before the scan. A rewritten value that breaks a foreign key or a `CHECK` stops the export, and the store copy is rolled back.

## The demo copy

1. `backupDatabase(from, to)` of `src/store/backup.ts` copies the live store to a temp file. The export then opens the copy with `openStore` and the `embeddingModel` of the live `wikifact.json`, so the copy has the schema of this code.
2. In 1 transaction: set `session_id` and `search_id` of each row of `change_requests` to NULL; delete all rows of `retrievals`, `search_results`, `searches`, `tool_calls`, `model_calls` and `sessions`, in that order, which keeps the foreign keys valid; delete each row of `meta` except the keys that `openStore` checks (`schema_version`, `embedding_model`, `embedding_dim`), which drops the worker status, the pause note and the batch state; delete all rows of each `stg_*` table; apply the pairs to every `TEXT` column of every table except the full-text and vector index tables, the same columns that the scan reads.
3. The scan of the private terms. A hit skips step 4.
4. The journal mode `DELETE` and `VACUUM`, then a move to `<target>/demo/wikifact/game.sqlite`.
5. `<target>/demo/wikifact/wikifact.json` gets the `subject` and the `embeddingModel` of the live file and the keys of `demo.config`: the mode `deployed`, the mode that calls the model API with `ANTHROPIC_API_KEY` (the mode `local` falls back to the Claude Code login). The scan reads this file too.
6. Git tracks `demo/`, and the service never opens it. `npm run demo` (`scripts/demo.ts`) copies `demo/wikifact/` to `wikis/wikifact/` when `wikis/wikifact/game.sqlite` does not exist, then starts `serve --wikis ./wikis --http 7777` with the other arguments of the command (for example `--with-worker`). `wikis/` is ignored, so a search writes only to the copy, and the clone stays clean. To start again from the demo state, delete `wikis/wikifact/`.

After step 2, the export rebuilds `fact_versions_fts` from `fact_versions`, because the full-text index holds its own copy of the text. The vector tables hold numbers only, and stay as they are.
