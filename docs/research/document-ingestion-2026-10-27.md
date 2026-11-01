# Document ingestion against the agent fill, 2026-10-27

Issue [#93](https://github.com/Arkased/WikiFact-dev/issues/93). The question: can a model read a file and extract its claims, so that the claims enter the wiki at a lower cost per fact than the agent fill, with the same quality?

Each number is marked **measured** (a run of this study or a query of the store) or **estimated** (a calculation from other numbers, or from a transcript). All model runs used the Claude Code CLI with the `standard` quality preset. No request went to the live wiki. The live store was read from a snapshot copy. The pipeline ran on scratch wikis only.

## Summary

| Question                                     | Answer                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage of the fill (Sonnet 5.5, 3 runs)    | Each run covers 98.5% of the fill leaves (measured). The union of 3 runs covers 99.3% (measured).                                                                                             |
| Coverage of the fill (Haiku 5.5, 3 runs)     | Each run covers 78.2% (measured). The union covers 90.7% (measured).                                                                                                                          |
| Wrong claims in a sample of 100              | 0 for Haiku, 0 for Sonnet, 0 wrong and 2 partly for the fill (measured).                                                                                                                      |
| Claims that the claim check of the pipeline (Q7) splits | 12% (Haiku), 17% (Sonnet), 58% (fill requests as sent) (measured, 100 each).                                                                                                       |
| Cost per fact write, fill                    | $0.100 for the pipeline alone (measured, whole fill). About $0.111 with the agents (estimated).                                                                                               |
| Cost per fact write, A (one claim at a time) | $0.048 on an empty wiki (measured, 44 claims).                                                                                                                                                |
| Cost per fact write, B (batch)               | $0.069 on an empty wiki (measured, 44 claims).                                                                                                                                                |
| Cost per fact write, C (drafts that enter after the fact draft step) | $0.043 on an empty wiki with the dedupe pass (measured, 44 drafts). About $0.044 without the pass (estimated: the pass removed 1 duplicate draft that writes no fact, and the estimate adds its cost back). Quality of the facts written, 30 per source: the fill has 26 supported, 4 partly and 0 wrong, with 1 of 30 compound (3%); C has 30 supported and 7 of 30 compound (23%) (measured). |
| Largest saving                               | The claim check and split (Q7) and the fact draft (Q5) are 17% of path A (measured). The scope match (Q1) and the judgment (Q4) are the other 83%. The extraction call costs $0.0006 to $0.0009 per claim, against about $0.013 per request for an agent (estimated).        |

## The 10 files and the fill requests

The fill is every top-level submission (no `parent_id`) that arrived between 2026-10-17T03:00Z and 06:00Z (20:00 to 23:00 PDT on 2026-10-16). A request cites a file when its justification reads "Stated in <file>". A leaf is a request that was not split, or a child of a split request. The files are taken at the fill commit `d94e12f6`. All counts are measured, from the snapshot of the store.

| File                            | Lines | Fill requests | Split | Leaves | Accepted / duplicate / rejected | Fill pipeline cost (USD) | Fact writes |
| ------------------------------- | ----: | ------------: | ----: | -----: | ------------------------------- | -----------------------: | ----------: |
| docs/requirements/deployment.md |    69 |            10 |     5 |     15 | 13 / 0 / 2                      |                     1.80 |          13 |
| docs/design/lookup.md           |   109 |            18 |    12 |     34 | 17 / 8 / 9                      |                     4.48 |          18 |
| docs/technical/lookup.md        |   201 |            22 |    10 |     34 | 27 / 2 / 5                      |                     4.95 |          33 |
| src/store/queue.ts              |   416 |            12 |     8 |     23 | 17 / 2 / 4                      |                     0.77 |          17 |
| src/store/write.ts              |   403 |            13 |    10 |     24 | 16 / 4 / 4                      |                     1.25 |          16 |
| src/log/file.ts                 |   234 |             7 |     5 |     14 | 13 / 0 / 1                      |                     1.07 |          14 |
| src/embed/index.ts              |   132 |             6 |     4 |     10 | 6 / 2 / 2                       |                     0.30 |           6 |
| README.md                       |   124 |            22 |    12 |     37 | 26 / 5 / 6                      |                     5.15 |          27 |
| docs/code-standard.md           |   142 |            30 |    22 |     59 | 57 / 1 / 1                      |                     9.76 |          57 |
| docs/future.md                  |    44 |            22 |    13 |     39 | 31 / 3 / 5                      |                     6.06 |          32 |
| Total                           |       |       **162** |    101 |    289 |                                 |                    35.59 |         233 |

A fact write is a new fact or a new version of a fact. The requests of `src/store/queue.ts`, `src/store/write.ts` and `src/log/file.ts` ran in part on the older group path of the batch design, which is now removed (its rows are the group claim check Q7B, the group fact draft Q5B and the group reconciliation Q15), so their cost per request is low. The ids of the requests are in the store: `change_requests` where `justification like 'Stated in <file>%'` and `parent_id is null`.

Fill baselines for the whole fill (measured, from the fill note): 1,391 requests, 900 of them split into 2,223 children. The pipeline cost $177.05 for 4,962 calls, which is $0.127 per request sent. The fill wrote 1,582 new facts and 185 new versions, which is 1,767 fact writes. That is $0.100 per fact write for the pipeline. For the 10 files, the pipeline cost per fact write is $35.59 / 233 = $0.153 (measured).

Agent cost of the fill (estimated): 9 fill agents cost about $18.51 (token counts of their transcripts at the prices of `config/prices.json`). The cost per request divides by the 1,391 requests of the store, which gives about $0.0133. The agents sent 1,394 `requestChange` calls (measured, from the transcripts). 9 of these calls failed with a connection error (`ECONNREFUSED`, `ECONNRESET`, or "MCP server not connected") and the agents sent most of them again. The count of 1,394 calls less 9 failed calls is 1,385, which is 6 less than the 1,391 requests of the store. I did not find the cause of the 6: a request can arrive from a caller outside these 9 agents, or a call that failed on the client can have reached the server. Divided by 1,394 calls, the cost per call is also $0.0133, so the basis does not change the figure. The transcript counts may under-count output tokens. The fill total is then about $195.6, which is about $0.111 per fact write.

## The extraction prompt

One system prompt. The user message is `File: <path>` and the file with each line as `N<TAB>text`. The answer is JSON: `{claims: [{claim, line}]}`. Effort low.

```
You read one file of a repository and extract its claims for a fact wiki about that repository. The wiki answers the questions that a developer asks about the repository, so that the developer does not open the file.

A claim is one statement that the file makes about the repository and that a reader can check against the file.

Rules:
1. One claim states one attribute: one value, one rule, one name, one order, one limit or one cause. If a sentence holds two attributes (a value and its reason, two limits, two steps), write two claims.
2. A claim stands alone. Name its subject in full (the file, function, command, table or setting). Use no pronoun, and no words such as "above", "this file" or "the section". Keep the exact names, numbers and units of the file.
3. State only what the file states. Add no inference, no advice and no fact from your own knowledge.
4. Skip headings, links, navigation text, examples that only repeat a rule, and text that says nothing checkable.
5. For each claim, give "line": the number of the first line of the file that states it. The file text starts each line with its number and a tab.
6. Return every claim of the file, in file order.

Return the claims as JSON that matches the schema.
```

For path C the same prompt drafts facts. Rule 5 asks also for `file`. The answer holds `header` (at most 12 words, subject and attribute) and `content` (one sentence) for each fact. The code sets the justification to `Stated in <file> at line <N>.`

## Extraction results

3 runs of each model on each of the 10 files (60 calls). All numbers measured.

| Measure                                              | Haiku 5.5             | Sonnet 5.5           | Fill                |
| ---------------------------------------------------- | --------------------- | -------------------- | ------------------- |
| Claims, mean per run over the 10 files               | 538 (1,614 in 3 runs) | 791 (2,374 in 3 runs) | 289 leaves, 162 roots |
| Cost of 3 runs                                       | $0.0494               | $1.3287              | not applicable      |
| Cost per run of the 10 files                         | $0.0165               | $0.4429              |                     |
| Cost per claim                                       | $0.00003              | $0.00056             |                     |
| Claims that Q7 finds not to be one claim (sample 100) | 12%                   | 17%                  | 58% (roots as sent) |
| Claims with more than 1 attribute (strict judge)     | 82.5%, mean 2.36      | 85.8%, mean 2.52     | roots 96.3%, mean 3.42; leaves 74.0%, mean 2.42 |
| Wrong claims in a checked sample of 100              | 0 (100 supported)     | 0 (100 supported)    | 0 (98 supported, 2 partly) |
| Line number correct in the sample of 100             | 98                    | 100                  | 98                  |
| Fill leaves covered, mean of 3 runs                  | 78.2% (678 of 867)    | 98.5% (854 of 867)   |                     |
| Fill leaves covered, union of 3 runs                 | 90.7% (262 of 289)    | 99.3% (287 of 289)   |                     |
| Accepted and duplicate leaves covered, union         | 92.0% (230 of 250)    | 99.6% (249 of 250)   |                     |
| Extracted claims that the fill holds, mean of 3 runs | 48.4% (781 of 1,614)  | 46.0% (1,091 of 2,374) |                   |

How the quality was measured:

- **More than 1 attribute, primary measure.** The Q7 claim check of the pipeline (Sonnet, medium effort) ran on a seeded sample of 100 claims of each source. It says `oneClaim` true or false. Cost $0.0100 per call.
- **More than 1 attribute, strict judge.** A Sonnet judge (low effort) counted the attributes of every claim by a fixed rule. It is much stricter than Q7: it counts a value and its reason as 2, and a list of N items as N. Read it as an upper bound. The fill leaves also pass this judge with 74%, because the pipeline's Q7 accepts them as one claim.
- **Wrong claims.** A Sonnet judge (high effort) checked a seeded sample of 100 claims of each source against the text of the file. The verdicts are supported, partly, wrong and unsupported. The two partly verdicts of the fill were "A WikiFact search lookup is fast and cheap." (vague) and "An eval or a long run is resumable." (part of the claim is not in the file). I checked 16 extracted claims by hand and found none wrong.
- **Coverage.** A Sonnet judge (medium effort) matched each fill leaf to the extracted claims of one run. A fill leaf is covered when the extracted claims state its attribute and its value. I checked about 12 matched pairs by hand. All were sound.

Reading the coverage:

- **Forward (fill covered by the extraction).** Sonnet misses 2 fill leaves in the union of 3 runs. Haiku misses 27 of 289, mostly detail claims and cross-references (for example "`npm run test:ui` is skipped when neither Edge nor Chrome is installed.").
- **Reverse (extraction found in the fill).** About 54% of the extracted claims are not in the fill. The extraction holds about 2.7 times as many claims as the fill has leaves. The judge found the sampled extra claims true. The fill is therefore not complete, and the extraction is not a copy of it.

## The three paths

The question for the cost is what a claim costs from the file to the wiki. The study ran 44 claims of 2 files (22 of `docs/design/lookup.md` and 22 of `src/store/queue.ts`, the first 22 of each from one Sonnet run) on scratch wikis. The pipeline settings were the live settings (`standard` preset, local mode, the live subject).

| Path | How                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | Each claim is one request (`change` = the claim, `justification` = "Stated in <file> at line N."). The sequential path of the bulk test runs them one at a time through all 9 steps. |
| B    | The same 44 requests on the batch path of the bulk test (`BulkPath.Batch`, batch size 10, the default of `highVolume.batchSize`).                                                |
| C    | The extraction call drafts the facts (header, content, line). Each draft enters the pipeline after the draft step. See below.                                                    |

Path C entry. The pipeline has no entry point after the draft step, so the eval script `ingestc.ts` builds one from the existing exports of `src/updates/agent`: `createContext` with `claimChecked: true` (no claim check and split, Q7), `submissionHead` (the gather and the scope match, Q1), `merge` (the merge of two facts and the write of the merged version, Q2 and Q3, when 2 or more live facts match), `judge` (the judgment, Q4), and `finishSubmission` with `firstDraft` set to the extracted draft (no fact draft, Q5, and no narrowing, Q6, because the judge found no narrow target). The dependents loop and the write run as in the pipeline. No code of `src/` changed. The script is not in the repository. On the empty wiki, one dedupe pass runs first over the extracted drafts only: embedding cosine distance below 0.12 finds near pairs, and one Sonnet call per group of near pairs removes the duplicates. Paths A and B have no such pass. The orchestrator asked for it in path C, so the results below show path C on the empty wiki with the pass and without it. The pass cost $0.0148 (2 calls, measured) and removed 1 draft ("enqueueRequest requires a lookupRepair to have exactly one target.", `src/store/queue.ts` line 88). For the figures without the pass, I ran that 1 draft through the same path-C entry on a copy of the final state of the empty wiki (37 facts). The run cost $0.0430 (measured: Q1 $0.0170, Q4 $0.0261) and the judge called the draft a duplicate, so it wrote no fact. The wiki had 37 facts then, and not the facts that it held when the draft would have arrived, so the cost and the outcome of this draft in a real run without the pass are estimated.

Two wikis per path where the budget allowed:

- **Empty.** A new wiki with no fact. The first request finds no candidate. The wiki fills during the run, so later requests find the earlier ones.
- **Copy.** A copy of the `wikifact` store (2,214 facts). The fill already wrote these files into it, so the copy measures re-ingestion: many claims are duplicates. 22 claims or drafts (the 22 of `docs/design/lookup.md`) ran on it for paths A and C. Path B did not run on the copy.

### Cost per fact written

The extraction cost per item is added to the pipeline cost: $0.00056 per claim (Sonnet extraction) for A and B, and $0.00085 per draft (Sonnet, one file per call) for C. A fact written is a new fact or a new version. All numbers are measured, except the extraction share of A and B, which is the mean cost per claim of the 3 extraction runs.

| Path and wiki | Items | Requests run | Pipeline cost | Extraction and dedupe | Fact writes (new + new versions) | Leaf outcomes (accepted / duplicate / rejected) | Cost per fact write | Cost per item |
| ------------- | ----: | -----------: | ------------: | --------------------: | -------------------------------: | ----------------------------------------------- | ------------------: | ------------: |
| A, empty      |    44 |           52 |       $2.1887 |               $0.0246 |                  46 (41 + 5)     | 46 / 1 / 1                                      |             $0.0481 |       $0.0503 |
| B, empty      |    44 |           52 |       $3.4483 |               $0.0246 |                  50 (47 + 3), 46 facts live | 48 / 0 / 0                                      |             $0.0695 |       $0.0788 |
| C, empty, with the dedupe pass | 44 |          43 |       $1.5930 |               $0.0522 |                  38 (37 + 1)     | 38 / 1 / 4                                      |             $0.0433 |       $0.0374 |
| C, empty, without the pass (estimated) | 44 |   44 |       $1.6360 |               $0.0374 |                  38 (37 + 1)     | 38 / 2 / 4                                      |             $0.0440 |       $0.0380 |
| A, copy       |    22 |           28 |       $1.7025 |               $0.0123 |                  14 (14 + 0)     | 14 / 9 / 2                                      |             $0.1225 |       $0.0779 |
| C, copy       |    22 |           22 |       $1.4316 |               $0.0187 |                  11 (10 + 1)     | 11 / 7 / 4                                      |             $0.1319 |       $0.0659 |
| Fill, 10 files | 162 roots | 390 (162 roots + 228 children) | $35.59 | about $2.16 for agents (estimated) | 233 | 223 / 27 / 39 | $0.153 pipeline; about $0.162 with agents (estimated) | $0.220 per root; $0.123 per leaf (289 leaves) |
| Fill, whole   | 1,391 roots |          3,614 |       $177.05 |       about $18.51 (estimated) | 1,767         |                                                 | $0.100 pipeline; about $0.111 with agents (estimated) | $0.127 per root |

Notes on the table:

- **Requests run.** Each row counts all requests that ran: the requests sent, plus the children of the requests that were split (path A on the copy: 22 sent, 3 split, 28 run). The fill row for the 10 files counts 162 roots plus 228 children, which is 390. The 289 leaves are the 61 roots that were not split plus the 228 children (measured).
- **Path C empty extraction share.** $0.0374 is 44 drafts at $0.00085. The dedupe pass cost $0.0148 (2 calls) and removed 1 draft, so 43 requests ran. The row "without the pass" adds the rerun of the removed draft ($0.0430, measured on a copy of the final state of the wiki) to the pipeline cost; its outcome (a duplicate, no fact write) and so its fact writes and its leaf outcomes are estimated, because the wiki held 37 facts at the rerun and fewer when the draft would have arrived. Cost per fact write without the pass is ($1.6360 + $0.0374) / 38 = $0.0440, against ($1.5930 + $0.0522) / 38 = $0.0433 with it. The pass saves $0.0430 and costs $0.0148 here (estimated net saving $0.028 for 44 drafts).
- **Facts written and facts live (path B).** B on the empty wiki wrote 47 new facts and 3 new versions, and holds 46 live facts. One fact ("enqueueRequest kind default") was written at change 47 and a later change of the same request (change 49) wrote a deleted version of it, so the wiki holds 46 (measured, from `fact_versions` of the scratch wiki). The 47 is a count of new facts written, and the 46 is a count of facts that are left. The cost per fact write divides by the 50 writes.
- **Why the copy costs more per fact write.** Most claims there are duplicates of facts that the fill wrote. A duplicate costs the same calls as an accepted claim (the scope match Q1 and the judgment Q4) and writes no fact. The cost per item is the fairer figure for the copy. Path C costs $0.066 per item, path A $0.078 per item (same 22 items; A ran 28 requests because 3 claims were split).
- **Path B costs more than A.** The batch path ran the scope match (Q1) 115 times ($2.09) for 52 requests, and the group call of the batch (QG, which holds the judgment and the fact draft of a group) 39 times ($0.74). The bulk test sets the batch path for speed (wall time 698 s for B against 1,076 s for A) and not for cost.
- **One interrupted run.** The first try of path A stopped at the 600 s limit of my shell, with no result. Its model cost is not measured. I count it as at most $1.00 (estimated) in the total.

### Cost by question

Calls and cost, measured.

| Question          | A, empty (44 claims) | B, empty         | C, empty (44 drafts) | A, copy (22 claims) | C, copy (22 drafts) |
| ----------------- | -------------------- | ---------------- | -------------------- | ------------------- | ------------------- |
| Q7 claim check    | 52 calls, $0.331     | 52 calls, $0.484 | skipped              | 28 calls, $0.274    | skipped             |
| Q1 scope match    | 47 calls, $0.953     | 115 calls, $2.094 | 42 calls, $0.855    | 25 calls, $0.550    | 22 calls, $0.533    |
| Q2 / Q3 merge     | none                 | 7 calls, $0.128  | none                 | 1 call, $0.024      | 3 calls, $0.074     |
| Q4 judgment       | 48 calls, $0.865     | none (inside QG) | 43 calls, $0.738     | 25 calls, $0.830    | 22 calls, $0.824    |
| Q5 fact draft     | 46 calls, $0.039     | none (inside QG) | skipped              | 14 calls, $0.024    | skipped             |
| QG group call     | none                 | 39 calls, $0.743 | none                 | none                | none                |
| Total             | $2.189               | $3.448           | $1.593               | $1.703              | $1.432              |

## Quality of the facts written

A checked sample is 30 facts of the wiki that the run wrote (all 30 verified by the high effort Sonnet judge against the file text, and the claim check of the pipeline, Q7, run on the same 30). The share of facts that Q7 splits stands for "more than 1 attribute" in the sense of Q7. A duplicate is a pair of facts that a Sonnet judge calls the same attribute and value, among all pairs of facts with cosine distance below 0.20. All numbers measured.

The fill row uses the same judge, the same prompts and the same measures. The facts are the 212 live facts of the snapshot that the fill requests for the 10 files wrote or changed (read-only, from the snapshot copy of the store; no request went to the live wiki). The sample of 30 is a seeded shuffle of these facts (seed 20261027, the seed of the other samples). The 212 is less than the 233 fact writes of the table at the top. A fact write counts each new version, so 1 fact can count more than 1 time. The count here takes each live fact 1 time. The model cost of this check was $0.53 (measured: verification $0.20, Q7 $0.30, duplicate judge $0.03).

| Wiki                                    | Facts in the wiki | Sample: supported / partly / wrong | Line number correct | Q7 would split | Duplicate pairs left (near pairs judged) |
| --------------------------------------- | ----------------: | ---------------------------------- | ------------------: | -------------: | ---------------------------------------- |
| A, empty                                |                41 | 30 / 0 / 0                         |               30/30 |          2/30 (7%) | 0 (38 pairs)                         |
| B, empty                                |                46 | 30 / 0 / 0                         |               30/30 |          1/30 (3%) | 0 (8 pairs)                          |
| C, empty                                |                37 | 30 / 0 / 0                         |               30/30 |         7/30 (23%) | 0 (4 pairs)                          |
| C0, no judge, all 10 files (see below)  |               527 | 27 / 3 / 0                         |               30/30 |         5/30 (17%) | 11 (205 pairs), which is 2.1%         |
| Fill, 10 files (live facts the fill wrote or changed) |  212 | 26 / 4 / 0                         |               27/30 |          1/30 (3%) | 0 (49 pairs)                          |

Findings:

- **The fill row.** The 30 facts of the fill: 26 supported, 4 partly, 0 wrong, 27 of 30 with the right line number, 1 of 30 that Q7 would split (3%), 0 duplicate pairs among 49 near pairs of 212 facts (measured). The 4 partly verdicts: a claim that no stderr line is written (the file names a stderr line), a claim of the build that the file does not word so, a claim that the refusal has a message (the file states the refusal only), and a claim that names `npm run deploy` where the file does not. The 3 wrong line numbers are a line that does not exist in the file (2 cases) and a line of another function (1 case). Compare C with the fill: C has no partly verdict and 30 of 30 right lines, against 4 partly and 27 of 30 for the fill. The fill has 3% compound facts against 23% for C. Neither source has a duplicate pair left. With 30 facts per row, the difference in the share of compound facts (1 against 7 of 30) is the only one that I read as real. The others (0 against 4 partly, 30 against 27 lines) are inside the noise of a sample of 30 (estimated).
- **No wrong fact in any sample.** 150 facts checked on 5 sources, 0 wrong. The extraction does not invent facts at the measured rate. The sample is small. The upper bound at 95% confidence for 30 clean facts is about 10%.
- **Path C lets more compound facts through.** The drafts skip the claim check. Q7 would split 23% of the sample of path C, against 7% and 3% for A and B, where the pipeline split the compound claims. Q4 catches some of them: it rejected 4 of 43 drafts of C on the empty wiki (9%) and 3 of 22 on the copy (14%) with the reason `compound`. A rejected draft is lost; Q7 would have split it into facts. The prompt of the extraction asks for one attribute, and it fails for 23% of the sample.
- **The judge leaves no duplicate.** A, B and C have no duplicate pair left. The no-judge variant C0 leaves 11 redundant facts in 527 (2.1%) even after its dedupe pass (cosine below 0.12, 4 removed). Near pairs at distance 0.12 to 0.20 hold the rest.
- **Rejections.** In path A the judge rejected 1 claim as `unsupported` (measured). The sampled facts of that wiki are all supported by the file.

### Variant C0: no judge

Before the owner narrowed path C, I measured a direct write with no judge on all 10 files: extraction (Sonnet, one file per call) returns 531 facts for $0.4499, one dedupe pass (cosine below 0.12, 21 groups, 21 Sonnet calls, $0.1444) removes 4, and the store write path `applyChange` writes the 527 remaining facts into an empty scratch wiki (5.4 s). The total is $0.5943, which is $0.00113 per fact written (measured). It is about 38 times cheaper than path C empty per fact written, and the quality is the same on the sample (27 supported, 3 partly, 0 wrong). It leaves 2.1% redundant facts and it never compares with a wiki that holds facts, so it fits only an empty wiki. It is not a path for a wiki that already holds facts.

## Batching the extraction

Sonnet drafted the facts of the 10 files with the fact prompt, once with one file per call and once with several small files per call (measured).

| Mode                                           | Calls | Facts | Cost    | Cost per fact |
| ---------------------------------------------- | ----: | ----: | ------: | ------------: |
| 1 file per call                                |    10 |   531 | $0.4499 |       $0.00085 |
| Up to 4 files and 14,000 characters per call   |     9 |   523 | $0.5782 |       $0.00111 |
| Up to 5 files and 24,000 characters per call   |     7 |   448 | $0.3997 |       $0.00089 |

- **No saving per fact.** The output tokens are most of the cost (2,131 to 7,718 output tokens a call, at $10 per million; measured). The instructions are about 620 tokens (estimated). At $2 per million input tokens they cost about $0.0012 a call, which is under $0.003 (calculated estimate). The mean call costs about $0.045, so one shared prefix saves up to about 2.8% of a call (calculated estimate: $0.0012 / $0.045).
- **Batching loses facts.** With 5 files per call, the small files lose half of their facts: `docs/requirements/deployment.md` 29 to 15, `src/log/file.ts` 30 to 16, `src/embed/index.ts` 22 to 15, `docs/future.md` 54 to 25. The model writes fewer facts per file when a call holds more files. The cost of the 7 calls is 11% lower, and the facts are 16% fewer.
- **Rule for the design.** Use one file per call. The largest answer (`docs/technical/lookup.md`, 98 facts) used 7,718 output tokens, so a call has room for a long file.

## What the pipeline can skip

For an ingestion path where each claim is already one fact, or nearly so. Savings are per item, from the tables above. "Measured" is the cost of the step in the runs of this study.

| Part                                    | Skip when                                  | Saving                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q7 claim check and split                | The extraction writes one attribute        | $0.0075 per item on the empty wiki (A: $0.331 for 44 claims, 15% of the path), $0.0125 per item on the copy ($0.274 for 22, 16%) (measured). Cost: 23% compound facts get through instead of 7% (measured, 30-fact samples). |
| Q5 fact draft                           | The extraction drafts header and content   | $0.0009 per item (A: $0.039 for 46 calls, 1.8%) (measured). The extraction call pays for the draft, at $0.00085 per draft in total. Almost no saving. |
| Q6 narrowing                            | The judge finds no narrow target           | None seen in the runs (0 calls) (measured).                                                                                                                                                    |
| Q1 scope match and the gather           | The wiki is empty and the batch is deduped | $0.0194 per item (C: $0.855 for 44 drafts). It is the largest single cost (54% of C empty). It has nothing to do on the first item of an empty wiki, and it matters afterward: the wiki fills during a run, and Q1 ran for 42 of 43 drafts of C. A dedupe pass over the extracted set replaces it at $0.0003 per draft (measured: $0.0148 for 44 drafts), but then it checks the set against itself only (estimated saving up to $0.019 per item, measured cost of the replacement). |
| Q4 judgment                             | The wiki is empty and the batch is deduped | $0.0172 per item (C: $0.738 for 43 drafts) (measured). It still matters whenever the wiki holds a fact on the subject (copy: 7 of 22 drafts were duplicates, 1 contradicted a fact). It catches compound drafts (4 of 43). The no-judge variant C0 shows the price of skipping it: 2.1% redundant facts. |
| Q2 and Q3 merge                         | Never in these runs on an empty wiki       | $0 on the empty wiki. On the copy it ran 3 times for $0.074 on 22 drafts (measured).                                                                                                           |
| Dependents loop (Q8), lookup repair (Q9, Q10), prior query check | The ingestion has no search to repair | Not seen as separate rows in these runs. A no-op here (measured: no Q8, Q9 or Q10 row in the 5 runs).                                                                                           |
| Embedding and the store write           | Never                                      | Local, no model cost. Writing 527 facts took 5.4 s on this machine (measured).                                                                                                                |

On an empty wiki, the cost of the pipeline is the scope match (Q1) plus the judgment (Q4) (about 83% in path A, 100% in C). The two questions answer: what does the wiki already hold on this subject, and does it agree. The first fact of an empty wiki needs neither. Later facts of the same run do need them, and a pass over the extracted set can replace them for duplicates (C0). It cannot replace them for a contradiction between a new fact and an old one.

## Cost against the agent fill

- **Per fact write, pipeline alone.** Fill $0.100 for the whole fill, $0.153 for these 10 files (measured). The pipeline-alone figures of the paths on the empty wiki leave out the extraction. The dedupe pass is counted for path C, because it does part of the work of the pipeline: path A $0.048 (2.1887 / 46), path B $0.069 (3.4483 / 50), path C $0.042 with the pass (the pass $0.0148 added: 1.6078 / 38) and $0.043 without it (1.6360 / 38, estimated), against $0.100 for the whole fill. So path A cuts the cost per fact write of the whole fill by 52%, path B by 31%, and path C by 58% with the pass and 57% without it (calculated from measured and estimated figures).
- **Per fact write, with the extraction.** The extraction ($0.0246 for A and B, $0.0374 for C) and the dedupe pass are added: path A $0.048, path B $0.069, path C $0.0433 with the pass and $0.0440 without it (estimated). Against the fill pipeline alone ($0.100), path C is 57% lower with the pass and 56% lower without it. The fill figure holds no agent cost, so this comparison favors the fill; against the fill with agents ($0.111, estimated), path C is 61% lower with the pass (calculated).
- **Per item sent.** The fill costs $0.127 per root request, with $0.013 more for the agent that read the files and sent it (estimated). Path A costs $0.050 per claim, path C $0.037 per draft with the pass and $0.038 without it, empty wiki.
- **The agent share.** The extraction call replaces the agent. Its cost per claim is $0.00056 to $0.00085, against about $0.0133 per request for the fill agents (estimated, about 16 to 24 times less). The extraction is 0.7% to 2.3% of the cost of the path in every run (A empty 1.1%, B empty 0.7%, C empty 2.3% without the pass, A copy 0.7%, C copy 1.3%; measured costs, calculated shares). For path C on the empty wiki, the extraction and the dedupe pass together are 3.2% ($0.0522 of $1.6452).
- **The copy wiki.** The comparison needs care. 9 of 25 leaf requests of A and 7 of 22 of C were duplicates, so each fact written costs $0.12 to $0.13. The fill had the same effect for its own duplicates: 27 of 289 leaves (measured).
- **A caution on the comparison.** The ingestion paths ran on 44 or 22 claims. The fill ran on 289 leaves for the same files. The cost per fact depends on the wiki size (Q1 and Q4 read more candidates as the wiki grows), so the empty-wiki numbers are lower bounds for a wiki of 2,000 facts. The copy wiki numbers ($0.066 to $0.078 per item) are the better guide for a wiki that is already filled.

## Method and limits

- **Cost** comes from the `model_calls` rows of each scratch wiki (tokens in, out, cache read, cache write) at the prices of `config/prices.json`. The extraction, the judges and the dedupe calls come from a ledger of the script. The prices: Haiku 5.5 $0.1 and $0.5, Sonnet 5.5 $2 and $10, Opus 5.5 $4 and $20 per million tokens (input and output). Cache writes cost 1.25 times the input price, cache reads 0.1 times.
- **Total model cost of the study:** about $23.1 (measured $22.1, plus at most $1.00 for the interrupted run). It is under the $25 cap. The parts: extraction 3 runs of 2 models $1.38, attribute judge $1.73, claim verification $1.00, coverage $1.16, Q7 samples $4.1, fact extraction (path C and variants) $1.43, dedupe and duplicate audit $0.33, the pipeline runs $10.37, and the review round of #93 $0.57 (the rerun of the removed draft $0.04, the quality check of the fill facts $0.53).
- **Samples.** The pipeline runs have 44 and 22 items. The quality samples have 30 facts. A difference of a few points between paths is inside the noise. The 12% to 17% and 58% Q7 figures come from 100 claims each.
- **Judges are models.** The verification and coverage judges are Sonnet 5.5. They are the same family as the extraction model. I checked about 28 of their verdicts by hand and found no error, which does not bound the error rate.
- **The Q7 figure is not the strict attribute count.** Q7 accepts a claim that a strict reader would call two attributes. The fill passed the same Q7 and the same strict judge also found 74% of its leaves compound.
- **Not measured:** path B on the copy; the duplicates left in the two copy wikis; path C with Haiku; a run of the extraction on the other 40 files of the fill.
- **Scratch scripts.** The scripts stayed in `.cache/i93/` (not in the repository). They call the public store and pipeline functions only. No code of `src/` changed.
