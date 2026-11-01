# Publication

Requirements layer. Accepted by the owner on 2026-10-29 (#111).

User: a reader from outside, who builds a memory or a wiki for AI agents, or who reads the project as a work sample. The developer makes each public release.

## Goal

The public repo shows what WikiFact does, what it is good for, and what its research found, to a reader who has none of the private context. The private repo `Arkased/WikiFact-dev` stays the work repo.

## Use cases

1. A reader learns in 1 page what WikiFact does, for whom, how it works, and its measured results.
2. A reader runs the demo wiki on their own machine and searches the facts that real agents wrote.
3. A reader who builds an agent memory reads the findings of the research and the notes behind them.
4. The developer makes a public release with 1 command.

## Requirements

| Name | Contract | Proof today | Gap |
|---|---|---|---|
| Public export | 1 command copies `build` into the public repo as 1 new commit, without the excluded paths. The excluded paths are the internal process: `CLAUDE.md`, `.claude/`, the issue templates, `reports/` (the deploy log and the dated build reports), and all the decision records (the owner, 2026-10-31: "this is operating cruft"). A reference to a decision record leaves no trace in the public tree, except in the recorded model output of a result file, which the export copies unchanged so that a published measurement stays the data that was measured. The export also leaves out `wikis/demo/`, because the folder holds only a config, and `demo:seed` creates it. The export keeps the code, the tests, the evals, the newest result file and the newest summary file of each result folder, and each result file that an exported text names, the 3 doc layers and the research notes. | The requirement test. | The test runs the export logic on a fixture repo and a fixture store. It does not run the command on the real repo, the real target or the live store. |
| Decision citations | A file of the repo outside `docs/decisions/` and the excluded paths cites a decision record only as an item of a reference list, a parenthesis of links and issue ids, so the export can remove the citation and leave a sentence that stands alone ([Links](../technical/publication.md#links)). | The requirement test. | The test proves the form of the citation, not that the sentence reads well without it. |
| No private data | The export stops when a file that it copies holds a private term: the user path, the email or the private repo names of the developer, or a board id. The private terms are in a file that the export does not copy. | The requirement test. | The test uses fake terms. It cannot prove that the real terms file lists every private term of the developer. |
| Real demo | The export holds a copy of the live `wikifact` wiki, the wiki that the agents of this project read and maintain. The quickstart starts the service on the copy. A reader searches and reads its facts and their history with no API key, because the search model runs in-process. A change request needs an API key. The copy passes the check "No private data". | The requirement test. | The test uses a small fixture store, not the live wiki, and does not run the quickstart or a change request. |
| README for readers | The README of the public repo says what WikiFact does and for whom, its aim (a wiki platform for AI agents, served over MCP, that works without human supervision), its findings, its limits, and a quickstart with Node 22. | The requirement test. | The test proves only that the text names these points. The owner reviews whether a reader from outside understands it. |
| How it works | The README tells at a high level how the wiki stays correct with no human review: agents send change requests, the update worker judges each request with narrow model questions, and later requests correct the wrong facts. | The requirement test. | The test proves only that the text names these points. The owner reviews whether a reader from outside understands it. |
| Detailed findings | The README gives each research finding that is interesting: the question, the setup, the count of runs, the result, what it means for a reader who builds a memory for agents, and a link to its note. A finding that is obvious, or that rests on a test too small or too weak to carry it, is not listed. | The requirement test. | The test can prove only the parts of each finding and its link. The owner reviews whether a finding is interesting. |
| Consumer plugin | The public repo holds the Claude Code plugin of WikiFact, with its source, its tests and its built hooks, and is a plugin marketplace. A reader installs the plugin with `/plugin marketplace add Arkased/WikiFact` and `/plugin install wikifact@wikifact`. The plugin gives the MCP entry of the service, the context hook, the submit hook and `/wikifact:setup`. It works with no other plugin: `/wikifact:setup` writes the wiki name of the project. The owner, 2026-10-31: "the hook should be published too". | The requirement test. | The test reads the files of the plugin. It does not install the plugin in Claude Code or run a hook in a session. |
| Open license | The public repo has a LICENSE file, and `package.json` names the same license. | The requirement test. | The license is open. |

## Out of scope

- The work process of the developer (the core and GitHub plugins of `claude-setup`, the board, the issues).
- The scripts that only the developer runs on Windows (`check`, `ship`, `deploy`) are copied, but the quickstart does not need them.
