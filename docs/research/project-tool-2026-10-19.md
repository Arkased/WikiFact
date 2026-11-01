# A project tool with tickets for the backlog

Backlog item: B-016. Date: 2026-10-19. Earlier assessment: [future.md](../future.md), "A project management tool for the backlog" (2026-10-17).

## Recommendation

Keep the current file and change one rule: a shipped item moves from the Items table to a "Done" table in `docs/backlog.md`, with the date, the commit and the result of the check. Do not adopt a tool now.

Why:

- The need is a record of closed work that agents can read and write with no click. A table in git does that at no cost and with no new part to run.
- The backlog holds 17 items. The trigger in `future.md` (more than 30 open items, a second person, or a board view) has not occurred.
- The repo has no git remote, so GitHub Issues does not apply without a new setup. Linear holds the data outside git, and its free plan caps issues.
- If the Done table grows too long to read, Backlog.md is the next step. It keeps the same data as files in git, so the move from the table is a one-time script.

## The 3 needs

1. Track the open work: the Items table already does this.
2. Evaluate the completed work: needs a closed record with the check result. Missing today.
3. Follow up on it: needs a way to find closed items by date, by commit or by result, and to reopen one. A table with a commit column covers search by `grep` and `git log`.

## Comparison

| | GitHub Issues + Projects | Linear | Backlog.md (files in git) | Current file + Done table |
|---|---|---|---|---|
| Open work | Yes | Yes | Yes | Yes |
| Closed record with check result | Yes, as the closing comment | Yes, as a comment | Yes, a Done status or an archive, with notes in the task file | Yes, one row with the check result |
| Follow-up (reopen, search) | Reopen, label, search | Reopen, search | `backlog task list`, `backlog search`, restore from archive | `grep`, edit the row |
| Agent access | `gh issue` works at once. Projects need the `project` scope of `gh`; the token here has `gist`, `read:org`, `repo` only. An official MCP server exists (issues in the default toolset, projects off by default) | Official remote MCP server, OAuth or API key | CLI with `--json`, and an MCP server over stdio (`backlog mcp start`) | Read and edit a file; no tool |
| Auth | `gh` logged in (account Arkased) | OAuth in a browser, or an API key | None | None |
| Cost | Free account | Free plan: 250 issues cap, per the pricing page. Basic $10 per user per month (yearly). Business $16 | Free, MIT license | Free |
| Setup on Windows | Needs a GitHub repo first: this repo has no remote (`git remote -v` is empty). Push, then `gh auth refresh -s project` | Account, workspace, MCP login, data model | `npm i -g backlog.md`, `backlog init`; Windows listed as supported; the doc has no Windows-specific steps | None |
| History of closed items | Kept on GitHub | Kept in Linear; the free plan cap may force archiving | Kept as files; archived tasks keep ID and links, read-only | Kept in the Done table |
| Link to commits | `Fixes #N` closes the issue from a commit; strong | Needs GitHub; weak for a repo with no remote | The docs do not say how tasks link to commits; an `autoCommit` setting exists. Put the hash in the notes by hand | A commit column; by hand or by the ship script |
| Link to decision records | A link in the body | A link in the body | A link in the body; the tool also has its own decisions folder, which would duplicate `docs/decisions/` | A link in the cell, as today |
| Lock-in | Data on GitHub; export by API | Data in Linear; export by API or CSV | Plain Markdown, MIT; low | None |
| Effort to move the 17 items | A script of `gh issue create` x 17, plus the remote | A script or manual entry x 17 | A script that writes 17 files; `Done when` maps to acceptance criteria | None |
| New rules to write | Many: labels, states, the `/work` skill, the ship script | Many | Medium: `/work` reads the CLI; `CLAUDE.md` section 6 changes | One: section 6, "remove an item" becomes "move to Done" |

## Facts and sources

Read on 2026-10-19.

- Linear plans: Free $0 with a 250-issue cap; Basic $10 per user per month, yearly; Business $16; Enterprise custom. Source: [linear.app/pricing](https://linear.app/pricing). The page lists "MCP access" but the fetched text did not show which plan has it. Aggregator sites disagree on whether closed issues count against the 250.
- Linear MCP: an official remote server at `https://mcp.linear.app/mcp`, OAuth or an API key, with a read-only endpoint. Source: [linear.app/docs/mcp](https://linear.app/docs/mcp), as summarized by a web search. Not read in full.
- Backlog.md (MrLesk): MIT; tasks are Markdown files in git; `backlog task list --json`; `claude mcp add backlog --scope user -- backlog mcp start` adds its MCP server; archive keeps the ID and links. Source: [github.com/MrLesk/Backlog.md](https://github.com/MrLesk/Backlog.md). It can generate `CLAUDE.md` or `AGENTS.md` text. `future.md` already says to keep our rules in `CLAUDE.md` instead.
- GitHub MCP server: MIT; `issues` toolset in the default set; `projects` toolset off by default; remote at `https://api.githubcopilot.com/mcp/` or local by Docker. Source: [github.com/github/github-mcp-server](https://github.com/github/github-mcp-server).
- GitHub Free includes unlimited private repositories. The plans page I fetched does not state the Issues and Projects limits for Free, so I did not verify them. Source: [docs.github.com plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans).
- Local facts: `git remote -v` prints nothing in this repo; `gh` is 2.88.1 and logged in, with token scopes `gist`, `read:org`, `repo`.

Not verified: the exact Linear plan that has MCP access, the GitHub Free limits for Projects, and the behavior of the Backlog.md `autoCommit` and commit links. None changes the recommendation.

## Options for the owner

1. Current file with a Done table (recommended). Change `CLAUDE.md` section 6 and the `/work` skill step 6 so a shipped and verified item moves to a "Done" table with the date, the commit and the check result. No tool, no cost, no move. Revisit Backlog.md when the trigger in `future.md` occurs or the Done table passes about 100 rows.
2. Backlog.md now. Move the 17 items to Markdown files in git with a script; agents use the CLI or the MCP server. Gives a board and per-ticket history. Costs a new npm tool, a rewrite of section 6 and the `/work` skill, and a decision on whether its decisions folder is used (it would duplicate `docs/decisions/`).
3. GitHub Issues. Push the repo to GitHub, refresh the `gh` scope for Projects, move the 17 items. Gives `Fixes #N` links from commits. Costs a remote the project does not have today, and puts the record outside the repo.
4. Linear. Gives the best board and the official MCP server. Costs an account, the 250-issue cap on the free plan or $10 per user per month, and a record outside git. Not advised for 1 owner and a repo with no remote.

## Second check, against the owner's needs (2026-10-19)

The owner then named the needs: a UI to track and follow issues, commits linked to issues, prioritization, links of blockers and dependencies, a highlight of the issues that need the owner's feedback, agent driven with human supervision, and private. Remote or local does not matter. The candidates were checked again against the vendors' docs of 2026-10-19.

| Need | GitHub Issues + Projects, private repo | Linear | Plane | Backlog.md |
|---|---|---|---|---|
| UI | Yes: issues, and a Projects table, board and roadmap | Yes | Yes, cloud or self-hosted | Partial: a local board in the browser |
| Commit links | Partial: `Fixes #N` closes an issue when the commit reaches the default branch | Yes, best: the issue id in the branch, the PR title or the commit, after a GitHub app and a webhook | Partial: the GitHub integration, not on the free plan | No |
| Priority | Partial: a single-select field "Priority" that a project adds | Yes | Yes | Yes |
| Blocked by, blocks | Yes, since 2025-08-21: a "Blocked" icon, the filters `is:blocked` and `blocked-by:`, `gh` flags, MCP tools; sub-issues too | Yes | Yes | Partial: `--dep`, no inverse link |
| Owner's feedback | Yes: a label `needs-owner` and a saved view | Yes | Partial | Partial: a label filter, no notification |
| Agents, supervision | Yes: the official `gh` CLI and the official GitHub MCP server, with dependency tools | Yes: official MCP, no CLI found | Yes: official MCP | Yes: CLI and MCP, history in git |
| Private, cost for 1 user | Yes, $0 | Yes, $0 up to 250 issues, then $10 per month | Yes, $0 with no integrations, $6 to $8 per month for them | Yes, $0 |

Result: GitHub Issues with Projects in a private repo meets the 6 needs at $0. It is the only candidate with the blockers, the CLI and the MCP server of the vendor. The commit links need a convention: `Refs #N` or `Fixes #N` in the commit message, and the default branch set to the branch that ships. Linear links commits better, but its free plan stops at 250 issues. Backlog.md links no commit.

Sources (2026-10-19): docs.github.com, "Creating issue dependencies", "About Projects", "Linking a pull request to an issue", "About single select fields", "Adding sub-issues", "GitHub's plans"; github.blog changelog 2025-08-21, "Dependencies on issues"; github.com/github/github-mcp-server; github.com/pricing; linear.app/docs/mcp, /docs/github, /pricing; plane.so/pricing; developers.plane.so, MCP server; github.com/MrLesk/Backlog.md. Not verified: a plain `#N` in a commit message as a link in the issue timeline; the export of Linear and Plane.
