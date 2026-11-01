# Bulk architectures: labels and estimates, 2026-10-22

Issue #60, steps 1 and 2. No model call was made and nothing in `src/` changed. The labels are in `fakes/bulk-expected.ts` (with a unit test in `fakes/__tests__/bulk-expected.test.ts`). The estimates come from the measured cost and time of each question ([cost note](cost-per-request-2026-10-22.md)) and the measured run of 100 requests ([bulk note](bulk-test-real-2026-10-22.md)).

## Result

- **Labels.** The 100 submissions end as: 40 accepted as new facts, 5 corrections of out-of-date seed facts, 18 duplicates of a seed fact, 5 duplicates of an earlier submission, 9 rejected as unsupported, 13 rejected as contradicted, 10 split. The 10 splits hold 28 claims: 1 accepted, 5 duplicates of a seed fact, 22 duplicates of the fact of an earlier submission. So the wiki must end with 41 new facts, the 5 seed facts corrected, no pair of live facts in one scope, no compound fact. 6 cases are unclear (below).
- **The estimate holds against the measured run.** The model of today's batch path gives 4.38 calls, $0.0631 and 1,863 s for each change request that ran. The measured run gave 4.58 calls, $0.0612 and 1,673 s (13.0 s). The benchmark row gives 3.12 calls and $0.0473; measured 3.05 and $0.0452. Errors: 4%, 3%, 11% for the batch; 2%, 5% for the benchmark.
- **Ranked combinations** (128 change requests that ran: the 100 submissions and 28 children; dollars on the bulk-test wiki, which is small and so has a small prompt; time at concurrency 4, the benchmark at concurrency 1):

| Rank | Architecture, shape | Calls per request | $ per request (bulk wiki) | $ per request (production sizes) | Wall time, 128 requests | Where accuracy can drop |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Benchmark: 1 request at a time, 1 concern per call | 3.12 | 0.0473 | 0.0919 | 3,419 s | none (the reference) |
| 1 | B groups first, 1 concern | 3.32 | 0.0496 (+5%) | 0.0952 (+4%) | 990 s (3.5x) | a pair split across 2 groups |
| 2 | A fixed batch, 1 concern | 3.98 | 0.0560 (+18%) | 0.1055 (+15%) | 1,068 s (3.2x) | every in-batch pair rests on the reconciliation |
| 3 | C 1 judgment per group, 1 concern | 2.40 | 0.0399 (-16%) | 0.0647 (-30%) | 824 s (4.1x) | the judgment of a whole group in one answer |
| 4 | D two phases, 1 concern | 3.43 | 0.0523 (+11%) | 0.0969 (+5%) | 2,317 s (1.5x) | almost none; the cost is time |
| 5 | B, merged pairs | 2.07 | 0.0618 (+31%) | 0.1069 (+16%) | 934 s | as B, plus the merged questions |
| 6 | C, merged pairs | 1.55 | 0.0449 (-5%) | 0.0697 (-24%) | 736 s | as C, plus the merged questions |
| 7 | A, merged pairs | 2.53 | 0.0717 (+52%) | 0.1205 (+31%) | 1,035 s | as A, plus the merged questions |
| 8 | D, merged pairs | 2.22 | 0.0638 (+35%) | 0.1080 (+18%) | 2,363 s | as D, plus the merged questions |
| 9 | B, 1 call per request | 1.22 | 0.0600 (+27%) | 0.1126 (+23%) | 913 s | all 4 concerns in one answer |
| 10 | C, 1 call per group | 0.75 | 0.0355 (-25%) | 0.0706 (-23%) | 732 s | all 4 concerns for a group in one answer |
| 11 | A, 1 call per request | 1.68 | 0.0699 (+48%) | 0.1262 (+37%) | 1,016 s | all 4 concerns in one answer |
| n/a | D, 1 call per request | | | | | collapses to D with merged pairs: phase 1 cannot be one call that includes the judgment |

- **Picks for step 3 (build and run on the same 100 requests):**
  1. **B, groups first, 1 concern per call.** Best cost, time and accuracy together: the calls of the benchmark plus a small reconciliation, 3.5 times faster, +4% to +5% dollars. In a group the requests run in queue order and see each other, so a duplicate or a conflict inside a group is judged as the benchmark judges it (25 of the 30 conflict pairs of the bulk test fall in one group at the cut 0.5 of the proxy grouping). It needs a grouping that keeps the largest group small.
  2. **A, the fixed batch, 1 concern per call.** The incumbent with the fixes for the conflicts inside a batch. It is the smallest build (the code exists), it gives the comparison for B and C, and it is 3.2 times faster. It costs 15% to 18% more than the benchmark; the extra calls are the 30 invisible duplicates that run the full write path (30 Q5 calls and a Q4 that sees no scope) and the reconciliation.
  3. **C, 1 judgment per group, 1 concern per call.** The only combination that cuts dollars (-16% on the bulk wiki, -30% at production sizes) and the weighted tokens (-45%). It has the highest accuracy risk, so it runs as a probe against the labels: if the labels are met it changes the ranking; if not, the numbers show how far it is.
- **Not picked, and why.** D has the accuracy of the benchmark but its phase 2 is serial: 1.5 times faster, 39 minutes for 128 requests against 18 for A and 16 for B. The owner judged the speed of the benchmark not viable, and D is only 1.5 times faster than it. It is the fallback if B and A fail the accuracy labels. The merged shapes raise the dollars by 12% to 28% in every candidate (Q7 moves from Sonnet to Opus, and the Opus draft costs more than the Haiku draft). They save 35% to 38% of the calls and 18% to 23% of the weighted tokens (2% for C, which already has few drafts per call), and they cut the wall time by 3% to 11% (D gets 2% slower). They add a new prompt and a new question set each. So they are a flag on the winner (B with the merge of Q7 and Q1) in step 4, if the quota binds on tokens; they are not a build of step 3. The shape of 1 call per request breaks the rule of the pipeline that a check that depends on no other step runs before any expensive step ([code-standard](../code-standard.md), section 7): the 19 requests that end at Q7 (unsupported and split) pay the full call, $0.10 in place of $0.008.

## The labels

Source: `fakes/bulk-expected.ts`. Written from the claim check of [submit.md](../design/submit.md) ("One claim, No beliefs", the 3 rules of the claim check) and the evidence rule of [updates.md](../design/updates.md). No outcome of a past run is copied; the notes of past runs were used only to find cases to look at twice.

| Outcome | Count | Positions in the queue (from 0) |
| --- | --- | --- |
| Accepted as a new fact | 40 | 2, 4, 10, 12, 14, 17, 21, 23, 25, 26, 29, 31, 35, 36, 40, 41, 43, 46, 49, 52, 53, 57, 60, 61, 63, 66, 69, 73, 74, 75, 78, 80, 84, 86, 88, 89, 92, 95, 97, 99 |
| Correction (new version of a seed fact) | 5 | 9, 24, 45, 64, 85 |
| Duplicate of a seed fact | 18 | 3, 11, 15, 22, 27, 32, 37, 44, 50, 54, 58, 65, 70, 77, 81, 87, 93, 98 |
| Duplicate of an earlier submission | 5 | 13, 19, 33, 47, 55 |
| Rejected, unsupported | 9 | 5, 16, 28, 38, 51, 59, 71, 82, 94 |
| Rejected, contradicted | 13 | 6, 8, 20, 34, 39, 48, 62, 68, 72, 76, 83, 90, 96 |
| Split | 10 | 0, 1, 7, 18, 30, 42, 56, 67, 79, 91 |

Rules that decide the labels:

- **Order.** The 100 run in queue order; the children of a split run after them, in the order of their parents. So the first submission of a claim is the new fact and the later ones are duplicates. Of the 28 children, 22 restate the fact of another submission of the queue and 5 restate a seed fact. This matters for the architecture: 22 of the 30 pairs that two requests of one batch can conflict on come from children.
- **A group of one claim in other words** (3 groups, 5 duplicates): the first member is new, the others are duplicates of it. A reason or a consequence after "because" or "so" is part of the claim (rule 1), so the lint-cache members are not split.
- **A group with conflicting values** (3 groups): the first member has a strong observation (a constant in the code), the later member an older draft. The later member is rejected as contradicted, and the kept fact holds `keeps` ("3 seconds", "1 hour", ".cache"). The reason is contradicted: the wiki holds the fact that the older draft disagrees with.
- **Hearsay against a seed fact** (3): rejected; the seed fact has an observation, the claim a report. Reason contradicted, also for the claim whose justification says it has no source: the wiki holds the seed fact that it contradicts.
- **A correction** (5): accepted as a new version of the seed fact it targets. The fact holds the new value and must not hold the old value (`avoid`).
- **Compound** (8, and the 2 of the issue): split. In every case the parts are different measures or different attributes that a reader looks up alone (rule 3). Model and effort of one question are 1 claim (rule 2), so "Q12 runs on sonnet with low effort" is not split. Each child is a duplicate of the new fact that another submission writes, except 1.
- **Belief or inference** (9): rejected as unsupported, whatever the claim.

Unclear cases, with the label I chose:

| Position | Case | Label | Why unclear |
| --- | --- | --- | --- |
| 0, claim 3 | "sessions with no search over 0.3 (NO_SEARCH_SHARE)" | accepted | By the evidence rule it is accepted: the justification is an observation and no fact disagrees. The constant NO_SEARCH_SHARE is not in `src/` at v0.1.81 (`NO_READ_SHARE` and `MANY_READS_SHARE` are), so the claim may be false and the wiki cannot know. |
| 2 | "seed-demo creates the demo wiki with 10 facts and 3 references" | accepted as 1 fact | Rule 3: 2 counts with their own names are 2 claims. Here they describe 1 output. If it splits, the wiki holds 1 more fact and the first child of position 56 changes. |
| 19 | "Cleaning the temp folders is a step that the operator takes by hand, never one that npm run check starts" | duplicate of position 4 | It adds "by hand". If that is a new attribute, it is an accepted new fact. |
| 35 | "An index file exports the public surface of its folder and holds no logic" | accepted as 1 fact | Rule 3: 2 attributes that a reader looks up alone. It is one rule in the standard. If it splits, +1 fact, and the first claim of position 42 duplicates the second. |
| 52 | "createWiki is annotated idempotent and not destructive" | accepted as 1 fact | Two annotation hints. If it splits, +1 fact. |
| 73 | "The first log line of serve and of worker names the mode, the transport and the condition" | accepted as 1 fact | Rules 2 and 3: the mode, the transport and the condition are 3 attributes that a reader looks up alone, and position 91 treats "names the mode" as its own claim. They are the 3 parts of one log line. If it splits, +2 facts, and the first claim of position 91 duplicates the first. |

A path that splits at 2, 35, 52 and 73 ends with up to 46 new facts (+1, +1, +1 and +2); the scorer should take 41 to 46 when it scores these four as unclear. The seed facts that the corrections replace are out of date by design; the duplicates of the high volume threshold (position 54) and the batch size (50) follow the seed wiki, not the target of the one bulk path.

## Estimates

### Method

- **Workload.** The 128 change requests that ran under the labels: 46 write (accepted and corrections), 63 end after Q4 without a write (50 duplicates and 13 contradicted), 19 end after Q7 (9 unsupported, 10 split). Calls of the benchmark: Q7 on all 128, Q1 and Q4 on 109, Q5 on 46, plus the 5 Q2 and 2 Q3 that the measured run shows (6 and 2 for 142 requests).
- **Cost of each question** (cost note, table "Tokens and dollars of one call", rows E2, submission requests; weighted tokens = in + 5 out + 0.1 cache read + 1.25 cache write):

| Question | Model | Seconds | $ at production sizes | Weighted tokens | $ on the bulk wiki |
| --- | --- | --- | --- | --- | --- |
| Q7 | Sonnet medium | 7.8 | 0.0082 | 4.6k | 0.0082 |
| Q1 | Opus medium | 7.1 | 0.0161 | 4.6k | 0.0161 |
| Q4 | Opus high | 11.0 | 0.0793 | 23.1k | 0.029 |
| Q5 | Haiku low | 8.5 | 0.0021 | 23.7k | 0.001 |
| Q2 | Sonnet medium | 8.0 | 0.0422 | 25.6k | 0.010 |
| Q3 | Haiku low | 8.5 | 0.0026 | 31.1k | 0.001 |

  The prompts of Q4, Q5, Q2 and Q3 hold the wiki block (about 33k tokens) at production sizes. The bulk wiki is small, so its calls are smaller. I set the dollars of the bulk wiki so that the benchmark matches the measured run: Q7, Q1 as measured; Q4 at $0.029 solves the total of $6.4188 for 433 calls (114 Q4) with Q5, Q2, Q3 set small. These bulk figures are fitted to one total, not measured for each question. The time per question is the same on both wikis.
- **Wall time.** For a batch: the sum of the seconds of the chain of each request, divided by 4 (concurrency 4), plus the reconciliation. For the benchmark: the sum, at concurrency 1. Code time (0.6% of a request) is left out. The check on the measured run: the model of today's batch gives 1,863 s against 1,673 s measured.
- **Merged questions.** Q7 with Q1 is one call on Opus medium (the model of Q1): 11.1 s (the fixed 3.8 s of one call saved), $0.0269, 8.05k weighted tokens (against $0.0243, 9.2k separately). It runs for all 128 requests, so the 19 that would end at Q7 pay the Q1 half too. Q4 with Q5 is one call on Opus high that adds the draft (950 output tokens) only when the claim is accepted: +$0.019 and +11.4 s (12 ms per output token on Opus, 3 times the Haiku rate of 5 ms) for a write, and 23.1k + 4.7k weighted tokens against 46.8k separately. The cost note estimated M at -8 s; at the Opus output rate the merged call is slower for a write, not faster. The rate is an assumption; the run of step 3 measures it.
- **1 call per request.** One Opus high call per request with the output of all 4 concerns: $0.100 without a write and $0.119 with a write at production sizes; 19.9 s and 31.3 s. There is no early exit.
- **Reconciliation, A.** Pairs are checked only among staged facts. The 30 requests that restate or contradict the fact of another request of the batch are invisible to each other at the gather (nothing staged is visible), so they take the write path (Q5 included): 76 write-path requests, 33 without a write, 19 early. Q1 pairs: 36 pairs inside the 6 clusters of 2 to 4 requests and 19 pairs of a child and its original, counted all-pairs, plus about 20 near pairs that are not duplicates: 56 Q1 calls. Per conflict resolved: 0.6 Q2 and 0.2 Q3 (the measured batch ran 17 Q2 and 5 Q3 against 6 and 2). The Q1 calls run at concurrency 4; the merges go in order inside a cluster (longest cluster, 4 requests: 3 merges of 16.5 s). Reruns alone: 0. The measured batch had 41 extra calls besides the 117 extra Q1 (Q7 +14, Q2 +11, Q5 +8, Q4 +5, Q3 +3), from reruns and merges.
- **Groups, B.** I grouped the 128 claims by word overlap, with a single-linkage cut (a proxy; the real grouping uses the embedder and the candidates of the search, not run here):

| Cut | Groups | Largest group | Of the 30 conflict pairs in one group |
| --- | --- | --- | --- |
| 0.3 | 45 | 57 | 29 |
| 0.4 | 53 | 35 | 28 |
| 0.5 | 68 | 18 | 25 |
| 0.6 | 87 | 6 | 24 |

  B is estimated at the cut 0.5: 5 conflict pairs cross a group and take the A path (51 write-path requests, 58 without a write, 19 early), with 16 reconciliation Q1 calls (the 5 pairs and near pairs across groups), 3.6 Q2 and 1.2 Q3. The wall time is the larger of the sum divided by 4 and the longest group (18 requests, about 500 s), plus 10%, plus the reconciliation. With the cut 0.3 the largest group is 57 requests, a serial chain of about 1,500 s, and B is no longer faster than A.
- **Judgment per group, C.** Q7 (and Q1) per request as in the benchmark, then 1 Opus high call per group: 60 groups of the cut 0.5 that hold a request with a judgment to make, 1.05 calls each for the retries of an invalid structured answer. A group call costs the Q4 call without its own output ($0.065 at production sizes) plus the output of the group: 66k output tokens in all (0.95k for each of the 46 drafts, 0.25k for the others), at $0.02 per 1k and 12 ms per token. With 1 call per group, the claim check and the scope match are inside the group call (+52k and +36k output tokens), and the children need a second round of group calls (+25).
- **Two phases, D.** Phase 1: Q7 on all, Q1 on 109, at concurrency 4. Phase 2: Q4 on 109 and Q5 on 46, one at a time in queue order: 109 x 11.0 + 46 x 8.5 = 1,590 s serial. Q1 again for the 30 conflicts and about 10 near cases whose scope changed: 40 Q1 calls, in the serial phase. The children take a second wave of phase 1 after the Q7 of their parents.

### Estimates, with the weighted tokens

Per change request that ran, 128 requests. Weighted tokens at production sizes (the wiki block in the prompt); on the bulk wiki they are about 2 times smaller (the measured benchmark: 19.2k for each request that ran).

| Architecture, shape | Calls | Weighted tokens | $, production | $, bulk wiki | Wall time | Calls in all | $ in all, bulk wiki |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Benchmark, 1 concern | 3.12 | 38.2k | 0.0919 | 0.0473 | 3,419 s | 399 | 6.05 |
| (reference) benchmark, merged pairs | 1.91 | 30.9k | 0.1029 | 0.0587 | 3,201 s | 244 | 7.52 |
| (reference) benchmark, 1 call per request | 1.05 | 31.9k | 0.1086 | 0.0569 | 3,126 s | 135 | 7.29 |
| (validation) today's batch, 1 concern | 4.38 | 50.9k | 0.1108 | 0.0631 | 1,863 s | 560 | 8.08 |
| A, 1 concern | 3.98 | 50.8k | 0.1055 | 0.0560 | 1,068 s | 509 | 7.17 |
| A, merged pairs | 2.53 | 39.1k | 0.1205 | 0.0717 | 1,035 s | 324 | 9.18 |
| A, 1 call per request | 1.68 | 40.1k | 0.1262 | 0.0699 | 1,016 s | 215 | 8.95 |
| B, 1 concern | 3.32 | 40.7k | 0.0952 | 0.0496 | 990 s | 425 | 6.35 |
| B, merged pairs | 2.07 | 32.7k | 0.1069 | 0.0618 | 934 s | 265 | 7.91 |
| B, 1 call per request | 1.22 | 33.7k | 0.1126 | 0.0600 | 913 s | 156 | 7.68 |
| C, 1 concern | 2.40 | 20.8k | 0.0647 | 0.0399 | 824 s | 307 | 5.11 |
| C, merged pairs | 1.55 | 20.4k | 0.0697 | 0.0449 | 736 s | 198 | 5.75 |
| C, 1 call per group | 0.75 | 19.9k | 0.0706 | 0.0355 | 732 s | 96 | 4.54 |
| D, 1 concern | 3.43 | 39.6k | 0.0969 | 0.0523 | 2,317 s | 439 | 6.70 |
| D, merged pairs | 2.22 | 32.3k | 0.1080 | 0.0638 | 2,363 s | 284 | 8.16 |

The calls, the dollars and the time include the reconciliation, the Q1 that D asks again, and the group calls with their retries. Reruns alone are 0 for A, B and D by construction; the measured batch paid up to 41 extra calls for reruns and merges.

### Where the accuracy can drop

- **A.** The 30 requests that depend on another request of the batch pass Q4 as new, because their scope is empty, and the reconciliation must catch them. (1) A missed pair leaves two facts for one claim: the reconciliation Q1 recall is the bar (the measured batch left 0 real pairs against 1). (2) A conflict loser (3 of 30: the older draft against the constant) is accepted by Q4, because Q4 sees no strong fact. The reconciliation then decides by Q2 (Sonnet medium), where the benchmark decides by Q4 (Opus high, 98.1% on its set), and Q3 may write a merged fact that mixes the true value with the false one in place of rejecting the claim. (3) The claim check Q7 changes with the architecture only through the batch: in the measured run 5 requests got another verdict than in the benchmark, which no architecture here fixes.
- **B.** The same as A for the pairs that the grouping puts in two groups (5 of 30 at the cut 0.5, 1 at the cut 0.3). Inside a group the requests see each other and are judged as the benchmark judges them. The risk moves to the grouping: a loose cut makes one giant group (57 of 128) and kills the speed; a tight cut sends more pairs to the reconciliation. A split child is grouped after the Q7 of its parent, so the grouping must run again for children.
- **C.** One answer decides every claim of a group, so: (1) the attention on each claim falls with the size of the group (the largest has 12 to 18 claims); (2) the evidence rule is judged across the justifications of the group in one prompt; (3) a malformed answer loses the group (5% retries are in the estimate); (4) there is no separate Q1 in the 1 call per group shape, so the scope match is not tested alone. The group questions of v0.1.61 to v0.1.68 (Q7B, Q5B, Q15) cost $0.0068 per request and were removed in v0.1.73 for quality (they accepted 2 compound claims that Q4 rejects). This is the main prior against C.
- **D.** Q4 and Q5 run one at a time on the wiki as the earlier requests left it, so the judgment equals the benchmark. The risk is the test of "the scope changed": if the test misses a new fact that falls outside the top candidates of the old Q1, the request skips the Q1 it needed and Q4 judges on a scope that lacks the fact. It is code, so a test can cover it.
- **Merged Q7 and Q1.** The claim check was designed to read only the change and the justification. With the candidates in view it may judge a claim "one claim" because the wiki already has it. The question sets of Q7 (94.4% on Sonnet medium) and Q1 (94.0% on Opus medium) do not fit the merged prompt; a new set is needed. The verdict of Q7 is also unstable: 5 requests got another claim-check verdict in the measured run (14 requests ended otherwise).
- **Merged Q4 and Q5.** The draft is written by Opus in place of Haiku, which may help the draft. The wiki block must stay in the Q4 prompt for the draft, so the cut of lever L1 (-24% dollars) is lost. The Q4 set (79 cases) measures the verdict, not the verdict with the draft: a new set from the logged Q4 and Q5 pairs.
- **1 call per request.** All of the above, in one answer, with correlated errors, with no early exit (19 requests pay 12 times more), and with none of the four question sets usable as it is.

### What the estimate does not know

- The counts of the reconciliation (56 Q1, 0.6 Q2, 0.2 Q3 per conflict for A) come from the structure of the 30 pairs and from the ratios of the measured batch. The log of the reconciliation, with the pairs of each newer fact, would fix them (the open item of the cost note).
- The grouping is a word-overlap proxy. The recall and the largest group of the real grouping are the first thing that step 3 measures for B.
- The bulk-wiki dollars are fitted to one measured total. The weighted tokens of the bulk wiki are the cost note's figures halved by the ratio of the measured run (19.2k against 38.2k for the benchmark).
- The speed of Opus output (12 ms per token) decides the time of the merged shapes and of C. The note on cost and the throughput note have no measured value.
- The cache: 4 parallel starts miss the cache in the first seconds (4 of 17 Q4 misses in the cost note). A can lose a few cents per batch on that; B, C and D start fewer calls at once or in order. Not in the numbers.
- The Q7 and Q4 verdicts themselves vary from run to run on the same text (the 14 requests with another outcome). The labels will show how much of it is the architecture and how much is the noise: the benchmark has to be scored against the labels too.

## Method

- Read: the records of the conflicts inside a batch and of the one bulk path; the rows "Consistent result", "High volume mode", "Reconciliation of a batch" of `docs/requirements/updates.md`; the section "High volume mode" of `docs/design/updates.md`; "One claim, No beliefs" of `docs/design/submit.md` and the "Evidence rule" of `docs/design/updates.md`; the sections "Time, calls, tokens and dollars" and "The 14 requests with another outcome" of the bulk note; the cost note.
- Labels: I read all 100 submissions in queue order (`fakes/bulk-submissions.ts`, `fakes/bulk-claims.ts`) against the seed (`fakes/bulk-seed-facts.ts`). I wrote each label from the rules, and I checked afterwards that the counts give the end state. The labels hold no value that the submissions already hold (outcome, reasons, seed, kept value and group come from `BULK_SUBMISSIONS`). The unit test checks that the anchors of each label are in the change of its position, that a duplicate of a submission restates an earlier one, that each duplicate and each correction names a real target, and that the facts add up to the end state.
- Estimates: a script outside the repo (the model above) with the table of questions as input, the counts of the labels as the workload, and the validation against the measured run. I did not keep it in the repo; the tables hold its inputs.
- Grouping proxy: word overlap (cosine of the content words) on the 100 changes and the 28 claims of the splits, single linkage at 4 cuts, counted against the 30 pairs of the labels.
