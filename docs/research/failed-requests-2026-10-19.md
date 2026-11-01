# Failed change requests, 2026-10-19

Backlog item B-011. Question: why do change requests fail, and which failures can a retry never fix?

## Result

14 of 3,217 finished requests of the dogfood wiki had a failed attempt, and 5 of them ended as `failed`. There are 3 kinds. None is a rate limit, and none is a code error that repeats by itself.

| Kind | Requests | Ended `failed` | Failed attempts | Cause | Deterministic | Fixed |
|---|---|---|---|---|---|---|
| Q4 answers `rejectReason: "compound"` | 8 | 3 | 14 | `mapJudgment` in `src/updates/agent/judge.ts` accepts only `unsupported` and `contradicted`; the Q4 schema allows `compound` | The throw is, the model answer is not: 3 of 8 repeated the answer on all 3 attempts, 5 of 8 changed it | Yes: Q4 `compound` is now a rejection with that reason |
| Draft failed the lint twice (Rule 1, two claims) | 5 | 2 | 11 | A compound submission passed the old step 1 and the drafts stayed compound | No: the draft is a new model sample on each attempt (3 of 5 recovered) | Already: Q7 splits or rejects a compound submission at step 1 (F22). No lint failure since 2026-10-11 |
| Q14 timeout, "no answer within 120 seconds" | 1 | 0 | 2 | A hung or slow model call (F21) | No, transient (the request is `done`) | Not a bug |

No failure of the store holds a rate limit, a credential error or a transport error. The rate limit path (`releaseRequest`, no attempt) works: no row shows it.

## Method

I copied `game.sqlite` and its `-wal` and `-shm` files from the live store to a folder outside the repo and read the copy. I listed every `change_requests` row with `status = 'failed'` or `attempts > 0`: 14 rows (5 `failed`, 9 `done`). I read the 27 `attempt_failed` lines of the `worker-wikifact.*.log` files (`request_id`, `attempt`, `status`, `error`) and the `question_call` lines of `worker-wikifact-calls.*.log` for the Q4 requests. The 27 lines split as 14 Q4, 11 lint, 2 Q14.

## Kind 1. Q4 `compound` (8 requests, 14 attempts)

Q4 returned `supported: false` and `rejectReason: "compound"`. The `RejectReason` enum has `compound` (Q7 uses it at step 1), so the Q4 output schema (`z.enum(RejectReason)` in `src/updates/questions/specs/q4.ts`) and the question check (`!o.supported && !o.rejectReason`) accept it. The Q4 prompt names only `unsupported` and `contradicted`, but the model finds a claim that joins 2 rules and picks `compound`. Then `mapJudgment` (`src/updates/agent/judge.ts`) threw `Q4 output invalid: rejectReason is required when supported is false`. The message is wrong: the reason was present.

The throw is a failed attempt. The Q4 call is made again, with the same input.

| Request | Q4 answers, in order | End |
|---|---|---|
| `01M543JT7J9R62D3XA90ZANG3X` | compound, compound, compound | `failed` |
| `01M543WWFD07DF828MJ23MYEZV` | compound, compound, compound | `failed` |
| `01M54549WMYDDBVBWJ65320HJT` | compound, compound, compound | `failed` |
| `01M4WFKGCTWFQZS07R2FR3H2X4` | compound, supported | `done` |
| `01M53ZAPCGKT79BM6GB3ZXY2BV` | compound, supported | `done` |
| `01M543H0J69FHYAR9KMS0GHFF7` | compound, supported | `done` |
| `01M543F5RKJ81EDED1VBJV79EG` | compound, contradicted | `done` |
| `01M53Z7JS799ZWNADX94K5FQQK` | compound, then one more attempt | `done` |

The failures sit on 2026-10-14 and 2026-10-17 to 18. Each is a claim that Q7 let pass as 1 claim and Q4 read as 2. The retry costs 2 more Q4 calls (about 50 seconds with the backoff) and, for 3 of 8, gives the same answer.

Fix: `compound` from Q4 is a rejection (`ChangeOutcome.Rejected`, `RejectReason.Compound`), as at step 1. The consumer sends the claims one by one. Any other value still throws.

## Kind 2. Lint failed twice (5 requests, 11 attempts)

All 5 are from 2026-10-11 (ids `01M4M4CN2ZG6KD4TDVGDJSAXV5`, `01M4M4JWHHA89FE40MXJF497KY`, `01M4M4JWJZY2D0FQXKJ5Y10Z5T`, `01M4M5J64BVD2MNACB35XV619R`, `01M4M60RPSSNNGGM71NAASWDFH`). Each was a submission with 2 claims. Step 5 drafted a fact with 2 claims, `lintDraft` in `src/updates/agent/lint.ts` rejected it twice (`LintError`: "draft failed lint twice"), and the attempt failed. 3 of 5 passed on a later attempt, so it is not deterministic. Since Q7 at step 1 (F22), no request failed this way: the newest failure of this kind is from 2026-10-11, and the log files hold none after it.

The 2 `failed` requests (`01M4M4CN2ZG6KD4TDVGDJSAXV5`, `01M4M4JWHHA89FE40MXJF497KY`) would now be split by Q7 into 1 child per claim. They are old enough that a put-back is a choice of the orchestrator.

## Kind 3. Q14 timeout (1 request, 2 attempts)

`01M4WD6ZCC1NAM0EV8A5W6R0JM`, a `cleanupRepair` row, 2026-10-14: "Q14: no answer within 120 seconds" twice, then `done` on the third attempt. This is F21, a transient failure, and the retry did its job.

## What is deterministic

A failure is deterministic when no new model answer can change it: the same stored data gives the same throw. In the code the only such class is `InvariantError` (`src/must.ts`), thrown by `must()` for a broken invariant of the store or of the code. No request in the store failed this way, so the rule is a guard for the future, not a repair.

Every place where `must()` throws `InvariantError` (a missing value that the store or the code must hold):

- `src/updates/agent/draft-utils.ts`: a fact with no version (2 functions), a draft with no `factId`.
- `src/updates/agent/gather.ts`: no embedding for a fact version; no embedding for the change text.
- `src/updates/agent/dependents.ts`: a dependent with no material.
- `src/updates/agent/merge.ts`: a merge with no fact; a dependent with no material.
- `src/updates/agent/submission.ts`: the merged fact not found after the merge.
- `src/updates/agent/summaries.ts`: a duplicate judgment with no existing fact.
- `src/updates/agent/draft.ts`: a narrow target with no claim draft; a wrong related fact not among the related facts.
- `src/updates/operator-edit.ts`, `src/updates/cleanup-repair.ts`, `src/updates/cleanup-repair-broad.ts`: a fact not found.

Not on the list, on purpose: a missing part of a model answer. These used `must()` at first and would have failed at once, although the next answer can differ. They now use `mustFromModel` (`src/must.ts`), a plain error and a failed attempt: Q3, Q5, Q6, Q9 and Q10 returned no draft, a unit with no draft, Q5 drafted only deletions. The judgment with no claim target and no delete target (`draft.ts`) also comes from the Q4 answer, so it is a plain error now.

Not deterministic, although it can repeat: a model answer that is invalid, a lint failure, a refusal or a truncated answer. Each is a new sample on the next attempt, and 8 of 14 requests here recovered. They keep their retries.

Rule in code: `runOnce` (`src/updates/run-once.ts`) catches an `InvariantError` and calls `failRequest` (`src/store/queue.ts`): the row becomes `failed` with `attempts` plus 1 at its first attempt, with its `attempt_failed` log line at level `error`. Every other error goes to `failAttempt` as before. A rate limit stays `releaseRequest`.

Open for the owner (design choice, not made): a `Truncated` answer (`max_tokens`) and a `Refusal` after the fallback can repeat on the same input. No request here met either. If one does, the rule can extend to `QuestionError` with those codes.

## Requests to put back

The Q4 fix repairs these 3 (all `failed`, all Q4 `compound`):

- `01M543JT7J9R62D3XA90ZANG3X`
- `01M543WWFD07DF828MJ23MYEZV`
- `01M54549WMYDDBVBWJ65320HJT`

Each will now end as `rejected` with the reason `compound`. A put-back is only worth it if the orchestrator wants the rejection recorded; the claims themselves are compound and the consumer must send them one by one.

The 2 lint failures (`01M4M4CN2ZG6KD4TDVGDJSAXV5`, `01M4M4JWHHA89FE40MXJF497KY`) were repaired earlier by Q7 at step 1. A put-back would run them through Q7 now.

## Files changed

- `src/updates/agent/judge.ts`: `mapJudgment` accepts `compound`; an invalid value says "is not accepted".
- `src/must.ts`: new `mustFromModel`; used in `draft.ts`, `dependents.ts`, `lookup-repair.ts`, `merge.ts`.
- `eval/replay-results/2026-10-20T00-25-22.255Z.json`: the real replay of this branch.
- `src/store/queue.ts`, `src/store/index.ts`: new `failRequest`.
- `src/updates/run-once.ts`: `InvariantError` fails at the first attempt.
- `__tests__/requirements/updates.test.ts`: the case "Failed request" proves 1 attempt for an `InvariantError`.
- `src/updates/__tests__/agent.test.ts`: the rejection test also runs for `compound`.

`src/updates/worker.ts` and `src/updates/worker-status.ts` are not touched. The worker needs no change: `runOnce` returns `RunOnceStatus.Failed` as before.

## Wiki gaps

The wiki fact "Failed model call kind classification" and the retry facts say nothing about Q4 `compound` or about the first-attempt failure. Requests for the wiki are sent with this note.

## Real replay

`npm run replay` on this branch, cli transport, concurrency 6: 16 cases, 0 with a duplicate or compound failure, 1 other miss (reported only). PASS against the bar "no duplicate and no compound fact". The miss is r11, a case that this change does not touch. Result file: `eval/replay-results/2026-10-20T00-25-22.255Z.json`.
