# MCP sessions that make no tool call

Question (backlog item B-008): does an MCP session open with no tool call? It decides what the reading "sessions with no search" of the Overview counts ([requirements/console.md](../requirements/console.md), "Agent adoption").

## Test, 2026-10-17, v0.1.48

3 headless processes, `claude -p` with Haiku, started 1 after the other from a shell at 21:48 UTC. 2 had a prompt with no tool. 1 had the prompt to call `listWikis` of the wiki server. All 3 failed before their first model call ("OAuth session expired and could not be refreshed" in that shell), so none made a tool call.

Result in the service log: 3 `session_start` lines at 21:48:27, 21:48:28 and 21:48:29, 1 per process, client `claude-code 2.1.301`. So a Claude Code process opens its MCP session at its start, before any tool call, and a process that never calls a tool still counts as 1 session.

## The same in normal use

The log of the same day holds `session_end` lines with `calls: 0` and the reason `idle` (for example 21:46:50 and 21:47:50 UTC). Those are interactive sessions that made no wiki call in 30 minutes. After the restart of the service for v0.1.48 at 21:16, 4 sessions opened within 1 minute: the open Claude Code processes of the machine reconnected, each as a new session.

## What it means for the reading

"Sessions with no search" counts every Claude Code process that connects, including a one-shot `claude -p` that never works on the project, and counts a process again after each restart of the service. The reading is correct for the question "which share of the connected processes never searched", and that is how the design defines it. A process is not an agent on the project, so the share is a floor of adoption, not a measure of it. The subagents of a process add no session (see [session-per-context-window-2026-10-17.md](session-per-context-window-2026-10-17.md)).
