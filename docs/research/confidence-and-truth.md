# Research: per-fact confidence, freshness and validity

Report from a research agent, 2026-10-03. The agent read the Wikidata ranking page and the NELL papers in full. The other claims come from search-result summaries.

## 1. Wikidata

- Each statement has one of three ranks. "Normal" means correct. "Preferred" means the best of the correct values, for example the latest population figure. "Deprecated" means wrong or outdated knowledge, even though a source once said it.
- Deprecated statements are never deleted. They stay so that editors know not to re-add the value. A "reason for deprecated rank" qualifier (P2241) says why.
- A value that was correct in the past is not deprecated. It gets start time (P580) and end time (P582) qualifiers instead.
- Conflicting claims can sit side by side, each with its own references. The simple query interface (`wdt:`) returns only the highest-ranked values. Full statement queries return everything.
- Gets right: wrong and historical are kept apart, and a "do not re-add" record survives. Gets wrong: there is no numeric confidence. Ranks are human judgment and go stale silently.
- Sources: https://www.wikidata.org/wiki/Help:Ranking , https://en.wikibooks.org/wiki/SPARQL/WIKIDATA_Qualifiers,_References_and_Ranks

## 2. Automated KB construction

- **Knowledge Vault (Google, 2014):** Several extractors produce candidate triples. Features such as the number of sources and the mean extraction score are fused by a supervised classifier. That score is combined with priors learned from Freebase. Platt scaling turns the result into calibrated probabilities. About 271M facts scored above 0.9.
- **Knowledge-Based Trust (2015):** A follow-up that scores web sources by how many false facts they give. It separates extraction errors from errors in the source itself.
- Gets right: probabilities are calibrated against ground truth. Gets wrong: a fact absent from Freebase is labeled false during training, so the priors favor facts that are already well known.
- **NELL (CMU):** Each component proposes candidates with a probability. A Knowledge Integrator promotes a candidate to "belief" if one source gives it more than 0.9, or if several sources propose it. Candidates that break mutual-exclusion or type constraints are blocked.
- NELL did drift. Precision of newly promoted beliefs fell from 90% to 71% to 57% over 66 iterations. Categories such as cardGame (casino web spam) and productType were the worst.
- The fixes were coupling constraints, plus 10–15 minutes of human review per day. Feedback over 58 months was mostly negative, about 2.4 corrections per predicate per month.
- In 2010 NELL had no temporal scope, so a former coach was scored as correct. By 2014 it held about 89M beliefs but only about 2M at high confidence.
- Gets right: candidates and beliefs are kept separate, and constraints catch errors. Gets wrong: once a belief is promoted, errors feed later learning, and removal depended on humans.
- Sources: https://www.cs.ubc.ca/~murphyk/papers/kv-kdd14.pdf , https://arxiv.org/pdf/1502.03519 , https://cdn.aaai.org/ojs/7519/7519-13-11049-1-2-20201228.pdf , https://www.cs.cmu.edu/~tom/pubs/NELL_aaai15.pdf , https://en.wikipedia.org/wiki/Never-Ending_Language_Learning

## 3. Truth discovery

- **TruthFinder (2007):** It iterates two estimates until they settle. A source is trustworthy if it states many true facts. A fact is likely true if many trustworthy sources state it. Similar facts support each other, and conflicting facts lower each other's score.
- Later work adds source copying, multiple true values and truths that change over time.
- Gets right: source reliability is learned, not assumed. Gets wrong: if sources copy each other, agreement is counted as independent evidence, unless copy detection is added.
- Sources: http://hanj.cs.illinois.edu/pdf/kdd07_xyin.pdf , https://arxiv.org/pdf/1505.02463

## 4. Temporal KGs (Zep/Graphiti)

- Each fact edge has four timestamps. `valid_at` and `invalid_at` record when it was true in the world. `created_at` and `expired_at` record when the system learned it and when the system retired it.
- An LLM compares a new edge with related existing edges. If they contradict and their time ranges overlap, the old edge's `invalid_at` is set to the new edge's `valid_at`. Nothing is deleted.
- "True until X" is simply `invalid_at = X`. Queries can ask both "what was true at T" and "what did we believe at T."
- Gets right: real-world change and system corrections are kept apart. Gets wrong: whether something is a contradiction depends on the LLM's judgment, and the edges carry no confidence score.
- Sources: https://www.getzep.com/blog/beyond-static-knowledge-graphs/ , https://www.researchgate.net/publication/388402077_Zep_A_Temporal_Knowledge_Graph_Architecture_for_Agent_Memory

## 5. Usage signals and decay

- **Generative Agents:** score = recency + importance + relevance, with all three weights set to 1. Recency decays by 0.995 per game hour since the memory was last retrieved. Importance is a 1–10 rating from the LLM. Relevance is embedding cosine similarity.
- Gets right: being retrieved resets the clock. Gets wrong: this measures how useful a memory is to surface, not whether it is true.
- **MemoryBank:** retention R = e^(−t/S), where t is time elapsed and S is a memory strength that goes up each time the memory is recalled. Memories that are rarely used fade.
- Gets right: use strengthens a memory. Gets wrong: popular errors get stronger too.
- **Duolingo half-life regression:** probability of recall p = 2^(−Δ/h), where Δ is time since last practice and h is a half-life learned from features of past practice. It improved recall by about 16% over the fixed schedule.
- Gets right: decay rate is learned per item. Gets wrong: it needs labeled recall outcomes.
- **WikiTrust:** this is the closest match to "read without being corrected." Text gains trust as editors revise the page around it without removing it. Each editor counts in proportion to their reputation. An editor's reputation grows when their text lasts.
- Gets right: surviving review is evidence of correctness. Gets wrong: only real review counts, and passive views do not.
- Sources: https://arxiv.org/pdf/2304.03442 , https://arxiv.org/pdf/2305.10250 , https://research.duolingo.com/papers/settles.acl16.pdf , https://en.wikipedia.org/wiki/WikiTrust

## What transfers to a small agent-maintained wiki

- Keep two scores per fact. Confidence (is it true) and salience (how often it is useful to surface) should be separate. Mixing them makes popular errors look reliable, which NELL and MemoryBank both show.
- Count a retrieval as support only when the fact was actually checked. "Read, used in a task, and not corrected" is like surviving an edit in WikiTrust. A bare read should affect recency only.
- Never delete a fact. Mark it deprecated with a reason, as Wikidata does, so the agent does not re-learn it.
- Store valid time apart from record time. "True until X" means setting `invalid_at`. A fact that is no longer current is not a wrong fact.
- Keep new claims as candidates until they get a second independent confirmation or one very strong one, as NELL's 0.9-or-multiple-sources rule does. Do not count copies of the same session or source as independent.
- Make confidence decay toward a prior with a half-life that is set per fact type. Volatile facts such as versions or prices decay fast. Stable facts decay slowly. Re-verifying a fact resets its clock.
- Track reliability per source, such as the session, tool or user. A source whose claims get corrected more often should carry less weight on its future claims.
- Use explicit constraints such as mutual exclusion and type rules to catch contradictions. Send low-confidence clusters to a short human review, which is how NELL contained drift.
