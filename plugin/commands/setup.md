---
description: Set up the wiki of this project (the permission for the wiki tools, the wiki name and one dedicated wiki)
argument-hint: "[subject of the project]"
---

Set up the WikiFact wiki of this project. Do the steps in order.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/setup.js"`. It adds the permission for the tools of the wiki server to `.claude/settings.json`, writes `wiki.name` to `.claude/setup.config.json` when the key is absent (the name of the project folder), and prints `written` or `unchanged` for each file. If it fails or prints `skipped`, show the message and stop.
2. Read `wiki.name` in `.claude/setup.config.json`. If it is null, the project chose no wiki: tell the owner to set `wiki.name` to the name of the wiki, and stop.
3. Call the MCP tool `listWikis`. If a wiki with that name is in the list, say so and stop: a second run creates nothing.
4. Take the subject from the arguments: `$ARGUMENTS`. If it is empty, ask the owner for one sentence that says what the wiki is about.
5. Call the MCP tool `createWiki` once, with the name from step 2 and the subject from step 4. Report the result in 1 line.
