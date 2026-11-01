# The search trigger without a CLAUDE.md line

Requirement: "When to search" ([requirements/lookup.md](../requirements/lookup.md)). The consumer needs no setup of its own: the server instructions and the `search` tool text tell it to search the wiki before it reads other sources.

## Test, 2026-10-18, v0.1.49

Until this day the owner's global `CLAUDE.md` held the line "Use the WikiFact MCP as the primary inquiry tool. Search here before reaching for file reads or other tools." The owner removed it and started a new Claude Code session. The orchestrator then started 1 subagent (general-purpose, Sonnet) with a repo question and no mention of the wiki: what the service does when the worker child of a wiki exits.

Result: the subagent called `ToolSearch`, `listWikis`, `search`, `getFact`, `getFact`, and answered from the wiki facts without a file read. Asked which instruction it acted on, it quoted the `search` tool description and the server instructions ("Search the wiki on a subject with the `search` tool before you read files or other sources about that subject, because it is faster and cheaper") and said that no `CLAUDE.md` file told it so.

A first run before the reload of the session was no test: the subagent quoted the removed line, because a subagent gets the global `CLAUDE.md` as its parent loaded it.

## Conclusion

The trigger travels from the server. 1 subagent of 1 is a small sample; the usage test (backlog B-002) measures it on 5.
