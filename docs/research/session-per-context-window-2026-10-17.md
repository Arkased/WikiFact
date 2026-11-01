# One session per context window: what a call carries

Requirement: [One session per context window](../requirements/deployment.md). Question: does a `tools/call` from a subagent of a Claude Code process differ from a call of the main context window of that process, so that the service can give each context window its own session?

## Capture, 2026-10-17, v0.1.48

The `tool` line of `search` records the JSON-RPC id, the keys of `_meta`, the header names and the user agent. 1 call from the main context window and 1 call from a subagent (general-purpose, Sonnet) of the same process, 2 seconds apart:

| Field | Main context window | Subagent |
|---|---|---|
| `mcp-session-id` header | same session | same session |
| `requestId` | 1 | 2 (the same counter) |
| `metaKeys` | `progressToken`, `claudecode/toolUseId` | `progressToken`, `claudecode/toolUseId` |
| `headerNames` | accept, accept-encoding, connection, content-length, content-type, host, mcp-protocol-version, mcp-session-id, user-agent | the same 9 |
| `userAgent` | `claude-code/2.1.301 (claude-vscode, agent-sdk/0.3.301)` | the same |

`claudecode/toolUseId` is the id of the tool use, 1 per call. It names the call, not the context window. Nothing in the call names the context window.

## Documentation

- Claude Code docs: a subagent with no `mcpServers` entry, or with a string reference, shares the connection of its parent. A subagent whose agent file holds an inline `mcpServers` definition opens its own connection when it starts and closes it when it finishes (https://code.claude.com/docs/en/sub-agents, "Scope MCP servers to a subagent").
- No documented per-agent identifier reaches an MCP server. Issue anthropics/claude-code#32514 asked for `agent_context { agent_id, parent_agent_id }` on tool calls; closed as not planned on 2026-05-11 with no maintainer response.

## Conclusion

The service cannot tell the context windows of 1 process apart from the calls. The 2 ways to meet the requirement are on the client side:

1. An agent file per subagent with an inline `mcpServers` definition of the wiki endpoint: each such subagent gets its own MCP session. The built-in agents (general-purpose, Explore, Plan) have no agent file and stay on the session of their parent. This is a setup for consumers, which the owner ruled out for the triggers on 2026-10-16.
2. A per-call agent id from Claude Code, in `_meta`. Not available; a request to Anthropic.
