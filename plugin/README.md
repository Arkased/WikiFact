# WikiFact plugin for Claude Code

The plugin connects Claude Code to a running WikiFact service. It gives the MCP entry of the service, 2 hooks and the command `/wikifact:setup`. It needs no other plugin.

## Install

```
claude plugin marketplace add Arkased/WikiFact
claude plugin install wikifact@wikifact
```

The MCP entry is `http://127.0.0.1:7777/mcp`, the management endpoint of the service on your computer. Start the service first (see the main README).

## Hooks

The hooks read the wiki name from `wiki.name` in `.claude/setup.config.json` of the project. With no file or no name they do nothing.

- `wiki-context.js` (SessionStart, SubagentStart): tells the session or the subagent to search the wiki before it reads files, and to send what the wiki lacks with `requestChange` before the task ends.
- `wiki-submit.js` (PreToolUse of `SubagentHandback`, SubagentStop): when a subagent searched the wiki and sent no `requestChange`, asks it once for a change request before it ends.

## Setup

Run `/wikifact:setup [subject]` in the project. It:

1. adds the permission rule `mcp__plugin_wikifact_wikifact` to `permissions.allow` in `.claude/settings.json`;
2. writes `wiki.name` to `.claude/setup.config.json` when the key is absent (the name of the project folder in lower case, each run of other characters as `-`, cut to 40 characters, with no `-` at the start or end, or `wiki` when nothing is left), keeping every other key;
3. creates the wiki with that name and your subject when the service does not list it yet.

Each file prints `written` or `unchanged`; a second run changes nothing.

## Files

The hook files in `dist/` are built from `src/` by `npm run build` of the repo and are tracked in git, because Claude Code runs a plugin from its folder with no install step.
