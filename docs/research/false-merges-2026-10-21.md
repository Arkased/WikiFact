# The false merges of issue #23, 2026-10-21

The judge of the test of both paths (#18) found 3 true facts of the wiki `wikifact` that merges had deleted: "Node.js version requirement", "Negation of a deleted fact" and "Negation request on a deleted fact". This note gives the 3 merges, their cause, the effect of v0.1.68 on them, and the repair. The method: read the `changes`, `fact_versions` and `change_requests` rows of the live database (read-only), and the `question_call` lines of the worker call logs of 2026-10-18.

## The merges

All 3 merges ran on 2026-10-18, 3 days before v0.1.68 (deployed 2026-10-21 05:33 UTC). The duplicate fact finder did not make them: each is the merge step of a normal submission.

| Seq | Time (UTC) | Request | Kept fact | Deleted fact |
| --- | --- | --- | --- | --- |
| 2147 | 2026-10-18 04:37 | `01M54549WMYDDBVBWJ65320HJT`, the claim "WikiFact is written in TypeScript on Node.js 22 with better-sqlite3." | SQLite access library | Node.js version requirement |
| 2292 | 2026-10-18 18:11 | `01M547CM1DMZSMH7GR5AX5A3A2`, the claim "The request of a claim that a deleted fact is no longer true ends as a duplicate of the deletion with no confirmation event." | Stale deleted fact negation | Negation of a deleted fact (and "Duplicate outcome for a negates change on a deleted fact") |
| 2394 | 2026-10-18 18:51 | `01M55S1TC04E1KEA21NZQM0PQD`, the claim "When Q4 answers negates on a deleted existing fact, no confirm row is written." | Stale deleted fact negation | Negation request on a deleted fact (and "Q4 negates answer on deleted fact") |

The claim of each request then went on to Q3 to Q5. The request of seq 2147 created "WikiFact implementation stack" (seq 2560) after the merge. The requests of seq 2292 and 2394 created "Negation request on a deleted fact" (seq 2293) and "Q4 negates answer on deleted fact confirm row" (seq 2395).

The merge reason in each case is the Q2 reason:

- Seq 2147: "The two facts state different things (the SQLite binding versus the Node.js version requirement), so their contents disagree. Both justifications rest only on documentation read ... so the observations are equally strong and 'kept' stands."
- Seq 2292: Q2 compared "Stale deleted fact negation" (a restated deleted fact gets a live negation) with "Negation of a deleted fact" (a negation of a deleted fact writes nothing), found that they "disagree", and kept the older fact on a tie.
- Seq 2394: the same comparison with "Negation request on a deleted fact", with the same result.

## Cause

Two steps are at fault, and the second is the one that does the damage.

1. Q1 reads the claim and the headers only. For seq 2147 the claim joins 3 attributes (language, Node.js version, SQLite binding), so Q1 matched the fact about the binding and the fact about Node.js, which are 2 scopes. For seq 2292 and 2394 the claim is about a negation request on a deleted fact. Q1 matched 4 of 15 candidates (seq 2292) and 7 of 15 (seq 2394), all with headers about negation or deleted facts, but whose contents describe different cases: a restated deleted fact (live negation version), a negation request (duplicate, no write), and the absence of a confirm row. Headers that name the same words put sibling scopes in 1 scope.
2. Q2 had 2 answers, "kept" and "other". Its prompt said "when they disagree, the stronger observation stands". The model (Haiku, low effort) read 2 facts about different attributes or cases as a disagreement, found the evidence equal (all documentation reads), and kept the older fact. The merge step then deleted the other fact. There was no answer for "both can be true". The same fault produced the 4 wrong merges of the duplicate fact finder ([duplicate-fact-run-2026-10-21.md](duplicate-fact-run-2026-10-21.md)), so #23 and #31 have 1 cause. The `scope_overmatch` log line (Q4 `unrelated`) shows that the 1-request path can already answer this, but the merge could not.

## Does v0.1.68 cover it

Partly, and the cover is not proven for 2 of the 3.

- v0.1.68 adds the Q2 answer `unrelated`. The prompt says: "When the two contents are about another subject or attribute, so that both can be true together, the answer is 'unrelated' ... The facts must not merge, and neither is deleted." Q2 also runs on Sonnet 5.5 medium in the budget and standard presets, not Haiku low.
- Seq 2147: yes. Q2's own reason says the facts "state different things", which is the `unrelated` test. A Node.js version and a SQLite binding can be true together.
- Seq 2292 and 2394: probably. The kept and the deleted fact describe 2 cases (restated deleted fact, negation request on a deleted fact), and both can be true together, so the prompt asks for `unrelated`. But the contents share terms and their wording looks like a contradiction ("gets a live version" against "writes nothing"), so a model can still answer "kept".
- I did not run Q2 on these pairs. The runner (`npm run questions`) reads only the case sets under `eval/questions/` and needs a credential, so a test of 3 ad hoc pairs would need a change to a set file in the repo. This note reasons from the prompt. A run of the 3 pairs as new cases of `eval/questions/q2.json` would settle it.
- Q1 is unchanged: it still over-matches. v0.1.68 stops the loss of the fact, not the wrong match.

## Current state of the 4 facts

| Fact | State on 2026-10-21 | True in the code base |
| --- | --- | --- |
| Node.js version requirement | Deleted (seq 2147). Two live facts hold the same claim: "wikifact package Node requirement" (seq 4217) and "WikiFact implementation stack" (seq 2560). | Yes: `README.md` line 16 ("Node 22 or later.") and `package.json` lines 6 to 8 (`engines.node` is `>=22`). |
| Negation of a deleted fact | Deleted (seq 2292). Related live facts: "Q4 relation negates on deleted fact" (seq 3004). | Yes: `src/updates/agent/judge.ts` lines 128 to 131 return a duplicate of the deletion; `docs/requirements/updates.md` line 34. The justification of the deleted version cites line 62 of that file, which is a moved line. |
| Negation request on a deleted fact | Deleted (seq 2394). Related live facts: "Q4 negates answer on deleted fact confirm row" (seq 2395) and "confirm row for deleted duplicateOf" (seq 3521). | Yes: `judge.ts` lines 128 to 131, and `src/store/writeSteps.ts` lines 96 to 97 (a deleted `duplicateOf` gets no confirm retrieval). |
| Operator console agent adoption | Already corrected. Seq 4393 (2026-10-21 03:55) changed the content to "no longer shows an Agent adoption block". It is live. Its justification cites a worktree branch, which is not a stable reference. | Yes: `src/console/pages/overview.ts` lines 1 to 4 (3 blocks, none for adoption); no match for "adoption" in `src/`; `docs/design/console.md` line 316. |

So the 3 deleted facts are still deleted, and their content is true. The restated claims are partly covered by live facts, but the requirement-level facts and the Node.js fact with its README source are not.

## Repair

4 requests to the wiki `wikifact` through `requestChange`, sent 2026-10-21. The queue was paused by the operator at 05:48 UTC (reason: tokens), so the requests wait for a resume; the position was 15 to 18.

| Request id | Claim | Evidence |
| --- | --- | --- |
| `01M5GC11ZT86GVZNPWCRCS00W9` | WikiFact requires Node.js version 22 or later to run. | `README.md` line 16, `package.json` lines 6 to 8 |
| `01M5GC13AJHX4VEEJVEM511JMB` | A claim that a deleted fact is no longer true writes nothing to the wiki: the request ends as a duplicate of the deletion. | `judge.ts` lines 128 to 131, `docs/requirements/updates.md` line 34 |
| `01M5GC14WJC2SH0Q4XD4F3H6MW` | A request claiming a deleted fact is no longer true ends as a duplicate of the deletion, with no confirmation event written. | `judge.ts` lines 128 to 131, `writeSteps.ts` lines 96 to 97 |
| `01M5GC167E8FZ4FY0TPRGNG8WV` | The operator console Overview page no longer shows an Agent adoption block (a stable justification for the live fact). | `overview.ts` lines 1 to 4, `docs/design/console.md` line 316 |

Each request can end as a revival of the deleted fact, a new fact, or a duplicate of a live fact. The last case is acceptable for the Node.js fact and the two negation facts, because the claim is then live. Check the result after the queue resumes: the claim must be live, and Q4 must not answer `unrelated` wrongly or merge it into a sibling.

## Open points

- The 3 pairs are not tested against the new Q2 prompt. If the owner wants proof for #23, add them as cases to `eval/questions/q2.json` with the expected answer `unrelated`.
- Other merges of the same kind may exist in the wiki. The log line `scope_overmatch` marks a Q4 `unrelated` answer only; for the merge step the signal is a Q2 reason that says "different" or "disagree" about facts with different attributes. A scan of the `changes` rows with outcome `accepted` and a "Merged" summary, from before 2026-10-21, would count them.
