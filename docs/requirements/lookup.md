# Look up facts

Requirements layer. The design is in [../design/lookup.md](../design/lookup.md).

User: consumer. Tools: `search`, `getFact`. The roles are defined in [README.md](README.md#roles).

## Goal

The consumer wants a correct answer, faster and cheaper than a read of the system itself, with enough to decide if it can trust the answer.

## Use cases

1. Find 1 fact: search the wiki before it reads the code or the system. It gives key words and gets 1 ranked list of fact headers.
2. Read 1 fact in full: the content, the confidence and the justification.
3. Decide how much to trust a fact, from its confidence value.

For a broad question ("How does logging work?"), the consumer reads more facts of the list.
## Requirements

| Name               | Contract                                                                                                                                    | Proof today                                                                                                                                                                                                                                                    | Gap                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Search speed | A search takes less than 100 ms at the 95th percentile, with 100,000 facts, on a desktop CPU with no GPU, with the time to embed the query. | The requirement test. Eval: the speed test, bar p95 under 100 ms with the query embedding. | The requirement test proves the bar logic. Only the speed test, run by hand on a quiet machine, measures the speed: p95 52.2 ms at 100,000 facts on October 14, 2026 (p95 103 ms in an earlier run on a loaded machine). |
| Key-word search | For a query of key words, the correct fact is in the first 3 results, and it is the first result in 90% of the queries. | The requirement test. Eval: the relevance test, 21 key-word cases. | The relevance test runs by hand. |
| Question search | For a query written as a question, the correct fact is in the first 3 results. | The requirement test. Eval: the relevance test, 12 question cases. | The relevance test runs by hand. |
| No answer | In at least 80% of the queries that the wiki cannot answer, the search returns no fact, or only facts close in meaning: facts that an agent with that question could fairly open. An unrelated header costs the consumer 1 call to open it, so the bar is cheap, not perfect. | The requirement test. Eval: the relevance test, 6 unanswerable cases; a case lists its allowed neighbors when its query has any. | 5 of 6 pass (83%): one query of common words returns 3 unrelated facts that share only a common word with it. |
| Facts only | A search returns facts only. | The requirement test. | Met. Test: `Facts only` in `__tests__/requirements/lookup.test.ts`. |
| Result cap | A search returns at most a set number of results, so that the consumer can read them all. | The requirement test. | None |
| Headers only | A search returns headers, and no content. The consumer opens a fact to read its content. | The requirement test. | None |
| Chosen reads count | Only `getFact` counts toward usefulness and confidence. A search, a read by the worker, and a read by the console do not count. | The requirement test. | None for the worker. For the console, see "Reads not counted". |
| Confidence | Each fact has a confidence value from 0 to 1. It goes down with age when nothing confirms the fact. | The requirement test. | None |
| Query limit | A query longer than the window of the embedding model is refused with an error that states the limit. | The requirement test. | None |
| Linked reads | Each result of a search carries an id that the search minted for it. A read by that id names its search exactly, and no read is attributed to a search by guess. The consumer sets up nothing: the tool contract carries the id. | The requirement test. | None |
| Correction duty | The tool text tells the consumer to report a fact that disagrees with what it sees. | The requirement test. | None |
| When to search | When a consumer connects, the wiki tells it the subject of the wiki and to search the wiki before it reads other sources about that subject. The `search` tool text says the same. The consumer needs no setup of its own. | The requirement test. | Measured on 2026-10-29: with the server instructions and the tool text only, 0 of 5 subagents searched first. With the hook of the design, 4 of 5 searched first ([research](../research/agent-usage-2026-10-29.md)). |

## Future

None.
