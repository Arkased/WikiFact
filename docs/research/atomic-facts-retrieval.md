# Research: atomic claims and retrieval

Report from a research agent, 2026-10-03. Sources are at the end of each section.

## 1. Claim decomposition (FActScore, SAFE and others)

- FActScore has an LLM split a generation into "atomic facts," each a short statement with one piece of information. It then checks each fact against a knowledge source and reports the share that are supported.
- SAFE works in steps. It splits the response into sentences with NLTK and has an LLM break each sentence into atomic facts. Each fact is rewritten to be self-contained (pronouns resolved), facts irrelevant to the prompt are dropped, and each remaining fact gets up to 5 Google searches.
- SAFE agreed with 72% of human labels and won 76% of the disagreements it was checked on. It was about 20x cheaper than human annotators.
- Known failure modes:
  - Scores depend on how the text is split (Wanner et al. "DecompScore").
  - Trivial or repeated subclaims inflate scores; the Core filter keeps only unique, informative claims.
  - Splitting and decontextualizing pull against each other. Adding context ("He was a director" becomes "Tarantino was an influential 1930s director") can add wrong details and make a claim less atomic.
  - Running the two steps in a different order shifted scores by about 13 points on the same generations (DnDScore).
- Sources: https://arxiv.org/pdf/2403.18802 · https://github.com/google-deepmind/long-form-factuality/tree/main/eval/safe · https://arxiv.org/html/2403.11903 · https://arxiv.org/pdf/2407.03572 · https://arxiv.org/pdf/2412.13175 · https://martiansideofthemoon.github.io/assets/factscore.pdf

## 2. Proposition-level retrieval (Dense X)

- The authors had GPT-4 split 42k passages into propositions, then trained a Flan-T5-large "Propositionizer" on that output to split all of Wikipedia.
- Unit counts and average length:

| Unit | Count | Avg. words |
|---|---|---|
| Passages | 41.4M | 58.5 |
| Sentences | 114.2M | 21.0 |
| Propositions | 256.9M | 11.2 |

- Unsupervised retrievers gained +12.0 and +9.3 Recall@5 (35% and 22.5% relative) across five datasets. Supervised retrievers gained less.
- With a 100-word input budget, QA improved by about 5-8 points EM (Contriever +7.8).
- Most of the gain comes from long-tail entities. The study covered English Wikipedia only.
- Later chunking studies find the benefit depends on the task. Finer units raise recall but grow the index, and one clinical study found propositions gave relevant but often incomplete answers.
- Sources: https://arxiv.org/html/2312.06648v2 · https://aclanthology.org/2025.findings-acl.422.pdf · https://www.trychroma.com/research/evaluating-chunking

## 3. Triples vs natural-language facts

- Triples are a lossy format. HippoRAG's entity-centric OpenIE triples drop context, and ignored context caused about 48% of errors in its error analysis.
- HippoRAG 2 fixes this by putting the original passages into the graph next to the phrase nodes. It reports about +7 points F1 over a strong embedding retriever on associative tasks.
- GraphRAG builds hierarchical communities. Indexing is expensive, and new documents can force re-indexing.
- LightRAG keeps a flat entity/relation graph that is cheap to update incrementally.
- A 2025 EMNLP paper runs beam search over paths of propositions rather than triples.
- The common lesson: use triples or entities as an index, and keep natural-language text as the content.
- Sources: https://arxiv.org/html/2502.14802v1 · https://arxiv.org/pdf/2405.14831 · https://aclanthology.org/2025.findings-emnlp.568.pdf · https://aclanthology.org/2025.emnlp-main.317.pdf

## 4. Deterministic hybrid retrieval

- Practitioners run BM25 (SQLite FTS5) and vector search (sqlite-vec) and merge the two lists with Reciprocal Rank Fusion. These are reports from people building such systems, not controlled benchmarks.
- Reported latencies:
  - FTS5 under 1 ms.
  - Exact vector scan under 10 ms for a few hundred thousand vectors.
  - 10-30 ms warm in total; about 60 ms including embedding the query.
  - Under 50 ms at about 1M chunks.
- A legal corpus of about 100k documents reached Recall@5 0.863 and nDCG@10 0.722 with hybrid RRF.
- HippoRAG's Personalized PageRank graph walk needs no LLM at query time, apart from extracting entities from the query.
- Sources: https://github.com/samSignal/legal-hybrid-search · https://dev.to/soytuber/building-a-hybrid-rag-in-200-lines-sqlite-fts5-sqlite-vec-rrf-38h1 · https://github.com/liamca/sqlite-hybrid-search

## 5. Deduplication

- SemDeDup clusters the embeddings and drops pairs above a cosine threshold within each cluster.
- 0.95 is the most-cited threshold. One claim-level study chose 0.92, because 0.95 missed real paraphrases (redundancy measured 2-3 points lower).
- Thresholds depend on the embedding model, so calibrate on your own labeled pairs.
- Mem0 uses an LLM to dedup. It pulls the top-10 similar memories, and the LLM chooses ADD, UPDATE, DELETE or NOOP. Reported p95 latency was 1.44 s versus 17.12 s for full context.
- Sources: https://arxiv.org/html/2303.09540v3 · https://arxiv.org/pdf/2606.19819 · https://arxiv.org/html/2504.19413v1 · https://docs.nvidia.com/nemo/curator/curate-text/process-data/deduplication/semdedup

## 6. Rebuilding compound views

- GraphRAG summarizes Leiden communities level by level. Its planned "append" mode puts new entities into existing communities and re-summarizes only communities whose members changed. It re-runs clustering only past a set threshold.
- Community forks add content fingerprints so unchanged summaries are reused and stale ones are refreshed or pruned.
- RAPTOR clusters chunks (SBERT embeddings, Gaussian mixture clustering) and summarizes them recursively into a tree. With GPT-4 it reached 82.6% on QuALITY versus 62.3% before. It has no incremental update; you rebuild the tree.
- Sources: https://github.com/microsoft/graphrag/issues/741 · https://github.com/sadofriod/graphrag-ts/pull/5 · https://arxiv.org/pdf/2401.18059

## Recommendations for an atomic-fact wiki

- Store each fact as one decontextualized natural-language sentence of about 10-20 words. Name the subject explicitly and use no pronouns. Keep a source pointer back to the original passage.
- Add triples as metadata for graph walks. Do not use them as the stored fact itself.
- Retrieve with BM25 plus exact vector search merged by RRF. Expect well under 50 ms up to about 1M facts on SQLite.
- Dedup in two stages. Merge automatically at cosine ≥ 0.95. Send 0.85-0.95 to review or to an LLM ADD/UPDATE/NOOP decision. Calibrate the bands on about 100 labeled pairs for your embedding model.
- Run a Core-style filter at ingest to reject trivial or near-duplicate claims, so pages do not fill up with filler facts.
- Build each page as a fixed query over fact IDs. Store a hash of the fact set the page was built from, and rebuild only pages whose hash changed.
- Never edit a fact in place. Replace it, and keep the old version linked, so views and audits stay consistent.
- Lint for splitting errors: claims with no subject, claims that combine several facts, and context added during decontextualization that is not in the source.
