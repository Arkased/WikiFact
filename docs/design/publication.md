# Publication

Design layer. The requirements are in [../requirements/publication.md](../requirements/publication.md). The technical details are in [../technical/publication.md](../technical/publication.md).

## Approach

The private repo `Arkased/WikiFact-dev` stays the work repo. The public repo is `Arkased/WikiFact`. The export command writes a public tree into a local clone of the public repo and makes 1 commit there. The developer reads the commit and pushes it. The export never pushes, because a push publishes.

The public tree has 3 sources:

1. The tracked files of `build` at `HEAD`, without the excluded paths.
2. The public README, from `publication/README.md`. It takes the place of the private `README.md`.
3. A clean copy of the live `wikifact` wiki, the demo.

## How the design meets each requirement

### Public export

The export reads its rules from `publication/export.json`, a tracked file that the export copies too, so a reader sees what was left out:

- The excluded paths: `CLAUDE.md`, `.claude/`, `.github/ISSUE_TEMPLATE/`, `.worktreeinclude`, `reports/`, `publication/`, the private `README.md`, `wikis/demo/` (the folder holds only a config, and `demo:seed` creates it), and `docs/decisions/`. The decision records are the history of the work. The layer docs state what the system does, so a reader from outside needs no record.
- The eval result files: each result folder keeps its newest result file and its newest summary file, and each result file that an exported text file names by its file name. All other result files are left out. The second rule keeps each link of the docs and of `config/presets.json` alive.

A link in an exported markdown file to an excluded path becomes plain text: the export keeps the text of the link and drops its target. So the public tree has no dead link.

A link to a decision record is removed with its text, because the text (`decision 0127`) names a record that the reader cannot open. The removal is clean only when the link stands in a parenthesis that holds only references, for example `([decision 0164](...), [research](...))`. So the docs cite a decision record only in that form, and a requirement test fails on each other citation. The test runs in each check, so a bad citation stops the work that writes it, not the export.

The export builds the public tree in a temp folder, and replaces the whole tree of the target, except `.git`, only after the scan passes, so a file deleted in `build` is deleted in the public repo too. A write fault after the delete can leave a partial tree; the next run refuses the dirty target. The commit message is `WikiFact v<version>`, with the version of `package.json`.

### No private data

The private terms are in `publication/private-terms.txt`. Git ignores this file, so it is never in a commit of either repo. A line is either a term that stops the export, or a pair `<term> => <replacement>`. A pair is for a term that history holds and that no edit can remove, for example the user path in old fact versions.

The scan and the pairs have separate jobs. The scan must find a term in any spelling, so it compares only letters and digits: it drops every other character, ignores case, and also reads each text with its URL escapes decoded. The pairs must keep each file valid, so a pair replaces only a fixed list of spellings (plain, with `/`, escaped for JSON, as a Claude Code folder name, URL-encoded), each with the same spelling of its replacement. A spelling that no pair covers stays in the text, and the scan stops the export on it. So a gap in the pairs gives a false stop, never a leak.

The export applies the pairs to each copied text file and to each text column of the demo copy. It then scans each copied path, each copied text file, each text column of the demo copy, and the author and the committer of the commit, for each term of both kinds. A copied file that is not text stops the export, unless the rules file lists its path as binary; the scan reads such a file as latin1 and as UTF-16LE. On a match, the export lists each place and stops before it touches the public clone. It also stops when the terms file is missing or empty.

### Real demo

The live store of the `wikifact` wiki is 1 SQLite file. The export copies it with the SQLite backup API, while the service runs. In the copy it then:

1. Deletes the rows that record use, not knowledge: the sessions, the searches and their results, the tool calls, the model calls, the retrievals, the staging tables of a batch, and the state of the service in `meta` (the pause note, the worker status), which leaves only the keys that the store needs to open.
2. Keeps the facts, their full history, the changes and the change requests. These rows show how agents wrote and corrected the wiki with no human review.
3. Applies the pairs and runs the scan of "No private data".
4. Runs `VACUUM`, so the file holds no deleted text.

The copy goes to `demo/wikifact/game.sqlite`, with a `wikifact.json` whose mode calls the model API with the key of the reader. The service writes each search to its store, so the reader never runs the tracked file: `npm run demo` copies it once into the ignored folder `wikis/`, and serves the copy. So a clone of the reader stays clean, and a `git pull` works.

### README for readers, How it works, Detailed findings

The developer writes `publication/README.md` by hand, and the owner reviews it before the first release. The requirement tests read that file. They prove that it names the points that each row asks for, that each finding has its parts, and that each link to a note resolves in the public tree. They do not prove that a finding is interesting.

### Consumer plugin

The plugin is in this repo. The plugin serves the consumers of the product, so it is product code: it ships with the product and is public with it. The plugins of the work process stay private.

The repo root is a plugin marketplace with 1 plugin, `wikifact`, in `plugin/`. A marketplace in the repo root works for both repos: the developer adds the private clone as a local marketplace, and a reader adds `Arkased/WikiFact` from GitHub. The plugin folder holds built, self-contained hook files, because Claude Code runs a plugin from its folder with no install step.

The hooks keep their behavior ([When to search](lookup.md#when-to-search), [When to submit](submit.md#when-to-submit)). They read the wiki name from `wiki.name` in `.claude/setup.config.json`, the file that the core plugin of the developer also writes. `/wikifact:setup` writes that key when it is absent, so a reader needs no other plugin. The plugin code imports nothing from `src/`, `eval/` or `scripts/`, and they import nothing from it: the plugin runs in the session of the consumer, apart from the service.

### Open license

The developer adds the LICENSE file after the owner picks the license (#114). The export copies it, and the test compares it with the `license` field of `package.json`. The export removes `"private": true` from the public `package.json`.
