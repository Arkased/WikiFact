# Research: agent memory systems

Report from a research agent, 2026-10-03. How current systems store, update, dedupe and score facts.

| System | Unit of storage | Update path | Conflicts and dedup | Scoring | Scope | Retrieval |
|---|---|---|---|---|---|---|
| **Mem0 (v3, SDK 2.0, Apr 2026)** | Short natural-language fact ("User is vegetarian"), embedded. Entities are linked across memories. | One LLM call per turn extracts facts and only adds them. There is no UPDATE or DELETE pass. The hosted platform runs async (returns PENDING plus an event_id). The open-source version runs sync. | Conflicting facts pile up. Ranking, which is time-aware, has to bring the current one to the top. Optional `expiration_date` hides old facts. | Fused semantic, BM25 and entity-match scores. No importance or decay score. | `user_id`, `agent_id`, `app_id`, `run_id` | Hybrid: vector + BM25 + entity, fused. No LLM in the default single-pass search. |
| **Mem0 (2025 paper, pre-v3)** | Same kind of fact. Mem0g adds graph triples. | For each fact, the top 10 similar memories are fetched. An LLM tool call picks ADD, UPDATE, DELETE or NOOP. A conversation summary is refreshed async. | Vector store: contradicted facts are DELETEd. Mem0g: the old relation is marked invalid, not removed. | None | Same as above | Vector. Mem0g also uses entity-anchored graph search plus triple-embedding search. |
| **Zep / Graphiti** | Three layers: episodes (raw messages, kept intact), entity nodes and fact edges (triples), and community summaries. | LLM pipeline at ingest pulls out entities and edges per episode. It can run in the background. | Candidate duplicates are found by hybrid search, then an LLM decides whether to merge. For contradictions, an LLM compares the new edge with existing ones and sets `invalid_at` / `expired_at` on the old edge. Four timestamps: `valid_at`, `invalid_at`, `created_at`, `expired_at`. Nothing is deleted. | Rerankers: RRF, MMR, episode-mention frequency, node distance, cross-encoder | `group_id` (multi-tenant) | Hybrid: cosine + BM25 + BFS graph traversal. No LLM at retrieval (a cross-encoder is optional). |
| **Letta (MemGPT)** | Labeled memory blocks (size-limited text in the context window), archival passages (vector), recall (message history). Letta Code uses MemFS: a git-backed directory of memory files. | The agent edits its own memory through tool calls, synchronously. Sleep-time agents or "dreaming" consolidate in the background, in a git worktree, and merge back. | The LLM rewrites a block in place. In MemFS, git history keeps old versions. `/doctor` audits for duplication. | None | Blocks can be shared across agents. Sleep-time agents write to a primary agent's blocks. | Blocks are always in the prompt. Archival is vector search. The agent decides when to search. |
| **LangMem** | Collections (many small documents) or a Profile (one schema document). Also episodic and procedural (prompt) memory. | The LLM gets the existing memories and returns insert, update or delete operations. Deletes are off by default (`enable_deletes=False`). Runs in the hot path or in the background via `ReflectionExecutor` (debounced). | Update or consolidate. Delete only when enabled. No built-in versioning. | None | Hierarchical namespaces, default `("memories","{langgraph_user_id}")` | LangGraph store: vector + metadata filter. `query_limit=5`. |
| **Cognee (v1.0)** | DataPoints (graph nodes and edges) plus chunks in relational, vector and graph stores. Triplets can be embedded. | `remember` / `improve` (formerly `cognify` / `memify`). LLM extracts the graph. Enrichment is a separate pass. | Near-duplicate entities are merged into one canonical node. Deterministic IDs are possible. Temporal mode uses `close_node()` and `is_valid()`. It flags conflicts instead of overwriting them. | Feedback weights on the graph. `feedback_influence` (0 to 1) reshapes ranking. | Users, tenants, datasets, RBAC, NodeSets | Graph + vector. `GRAPH_COMPLETION` and similar modes use an LLM to answer. |
| **Anthropic memory MCP server** | Entity (name, type) holding a list of observation strings ("one fact per observation"), plus directed relations. Stored in a JSONL file. | The calling LLM chooses tools (`create_entities`, `add_observations`, `delete_observations`…). Sync. No reconciliation step of its own. | Exact-name entities and duplicate relations are silently skipped. No contradiction handling. The old fact stays unless the LLM deletes it. | None | One file per server (set by `MEMORY_FILE_PATH`) | Substring match on names, types and observations. No vectors. |
| **Basic Memory** | Markdown note. Observations are lines of the form `- [category] fact #tag`. Relations are `- rel [[Target]]`. | The LLM calls `write_note` / `edit_note`. Humans edit the same files. Sync. | No semantic dedup. `write_note` guards against overwrites. Versioning only through git or cloud snapshots. | None. Cross-encoder rerank is optional. | Projects | SQLite or Postgres full-text search + optional vector hybrid (FastEmbed) |

## Observations

- Units are getting smaller: one fact sentence or triple. The exceptions are Letta blocks and Basic Memory notes, which are coarser documents.
- Two schools handle contradictions:
  - **Write-time resolution:** old Mem0 and LangMem have an LLM pick ADD, UPDATE or DELETE.
  - **Keep everything and filter later:** Mem0 v3 is add-only and lets ranking choose. Graphiti and Mem0g invalidate with timestamps.
- Mem0 dropping UPDATE/DELETE in 2026 is the notable shift. Mem0 says it raised benchmark scores. Their own docs say "knowledge update" is the weakest category, because stale facts can come back alongside new ones.
- Only Graphiti has full bi-temporal validity: when a fact was true versus when the system learned it. Cognee has `close_node`. The rest have no time range on facts.
- None of the eight attaches confidence or importance to a fact. There is no access-count decay in any of them. Scoring exists only as retrieval ranking: rerankers, mention frequency, and Cognee's feedback weights. Nothing deletes facts for being old or unused, except Mem0's explicit `expiration_date`.
- Dedup is mostly "embedding search, then LLM decides" (Graphiti, Cognee, old Mem0). The MCP servers only dedupe exact names.
- Sharing is mostly done with namespaces or IDs, not real multi-agent sync. Letta's shared blocks are the clearest shared-across-agents design. Cognee has the richest permissions model.
- Retrieval is converging on hybrid vector + BM25, plus graph or entity signals. Most avoid an LLM at retrieval for speed. Cognee completion modes and Letta's agent-driven search are the exceptions.
- **Gaps:**
  - No system tracks where a shared fact came from (which agent, which source) in a way that is used to score trust.
  - No system resolves conflicts between agents writing to the same shared memory, beyond last-write-wins or git merge.
  - The simple MCP servers leave all reconciliation to the calling model.

## Sources

- https://docs.mem0.ai/core-concepts/memory-operations/add
- https://github.com/mem0ai/mem0
- https://mem0.ai/library/agent-memory/ai-memory-benchmarks-in-2026
- https://arxiv.org/html/2504.19413
- https://help.getzep.com/graphiti/getting-started/overview
- https://arxiv.org/html/2501.13956
- https://docs.letta.com/concepts/memgpt
- https://docs.letta.com/letta-agent/memory
- https://www.letta.com/blog/memory-blocks/
- https://www.letta.com/blog/context-repositories/
- https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- https://langchain-ai.github.io/langmem/reference/memory/
- https://docs.cognee.ai/core-concepts/overview
- https://docs.cognee.ai/llms-core.md
- https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- https://github.com/basicmachines-co/basic-memory
- https://docs.basicmemory.com/

Caveats from the agent:
- The Mem0 v3 details come from its README and a summary in the search results. The agent did not read the migration guide.
- Cognee's dedup method and feedback weights come from a summary of its docs, not from the code.
- Zep's LLM-based entity dedup is from the Zep paper. The Graphiti overview page does not describe how dedup works.
