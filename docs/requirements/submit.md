# Submit a change

Requirements layer. The design is in [../design/submit.md](../design/submit.md).

User: consumer. Tools: `requestChange`, `getRequest`. The roles are defined in [README.md](README.md#roles).

## Goal

The consumer wants to put what it saw into the wiki at the lowest cost, so that the next consumer does not pay to find it again.

## Use cases

1. Add a fact that the wiki does not have, after a search that did not find it.
2. Correct a fact that is wrong, or that is no longer true.
3. Check what happened to a submission: accepted, duplicate, or rejected, and the reason.

## Requirements

| Name                   | Contract                                                                                                                              | Proof today                                                                                                                                                                                                             | Gap                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| One call | A submission is 1 call with 2 text fields: what the consumer saw, and how it knows. Fact ids are optional. | The requirement test. | None |
| Queue position | The call returns at once, with the place in the queue and an estimated wait in seconds. | The requirement test. | None |
| Bad input refused | A submission with an empty field, or with an id that is not a fact, is refused at once with an error, and nothing is queued. | The requirement test. | Met. Test: `Bad input refused` in `__tests__/requirements/submit.test.ts`. |
| One claim | A submission with 2 or more claims is split into 1 request per claim, and each claim goes through the process alone. The consumer sends nothing again. A belief stays a rejection. | The requirement test. Eval: the question test of the claim check. | The quality of the split rests on Q7: the question test measures the count and the content of the claims. Not measured on a real run yet; the first fill after the release shows how many children are rejected as "compound". |
| No beliefs | A justification that is a belief ("I think", "should be") is rejected. | The requirement test. Eval: the question test of the claim check, 3 belief cases. | 3 eval cases only. |
| Rejection reason | The consumer can read the reason for a rejection. | The requirement test. | None |
| Missed search repaired | After the wiki adds a fact for a search that missed, that search finds the fact. | The requirement test. | None |
| Linked submissions | A submission names the search that it follows by the id that the search returned. The wiki reads the query of that search itself; the consumer repeats no text. | The requirement test. | None |
| When to submit | When a consumer connects, the wiki tells it to submit what it observed that the wiki does not have or gets wrong, before it finishes its task. The consumer needs no setup of its own. | The requirement test. | Measured on 2026-10-29 on 5 subagents: with the text only, 0 of 10 sent a change request; with the hooks of the design, 4 of 5 did, and each of the 4 that saw a gap sent it ([research](../research/agent-usage-2026-10-29.md)). The correction test (`eval/corrections.ts`) counts the corrections that consumers send after a read. It has no bar, and it reports the count. |

## Open points

- None of the 5 fill agents of today called `getRequest`. So a consumer almost never learns that its claim was rejected. Proposed: keep `getRequest`. It is the only way to learn the reason. The split of a compound submission removes the most common rejection.

## Future

A length limit on a submission; detection of a rejected claim that a second consumer sends again.
