# Searches with no result, 2026-10-19

Backlog item B-013. Requirement: "Search quality" ([requirements/console.md](../requirements/console.md)).

## Result

No bug. The count and the display are right. The number is not high: 3 of the last 200 searches (1.5%) and 27 of all 949 (2.8%). The page shows "2%" and "3%" on the live service (checked on 2026-10-19: "3 of 200 searches", "27 of 953 searches").

The 27 searches have 1 cause: the fill ran while the wiki was small. 25 of the 27 come from the 4 fill sessions, at a time when the wiki held 269 to 315 facts. It holds 973 now. Run again on a copy of the store, 25 of the 27 queries return results.

The page may look worse than it is for 2 reasons. The level is yellow for any count over 0 (`noResultLevel`), and the share rounds 1.5% up to 2%.

## Method

A copy of `game.sqlite` and its `-wal` and `-shm` files, read only. The live store was not written. The live console pages were read with GET.

## Counts

| Span | Searches | With `result_count` 0 | Share |
|---|---|---|---|
| Last 200 (`ORDER BY id DESC LIMIT 200`, from 2026-10-17 04:58) | 200 | 3 | 1.5% |
| All | 949 | 27 | 2.8% |
| Worst window of 200 in the whole log (from 2026-10-17 03:41) | 200 | 10 | 5.0% |

The live page counted 953 searches a few minutes later: 4 searches came in after the copy.

## Candidate causes

**A bug of the count or the display: no.** `readsPerSearch` selects the searches of the span and counts `result_count` 0 as `noResult`. `overview.ts` shows `noResult / searches`. The value on the live page equals the count in the copy for both spans.

**Searches from the fill, tests or the management endpoint:**

| Source | Searches | No result | Share |
|---|---|---|---|
| 4 fill sessions (claude-code, 2026-10-17 03:36 to 05:36, 64 to 421 searches each) | 888 | 25 | 2.8% |
| All others (8 searches with no session on 2026-10-16, and 53 in later sessions) | 61 | 2 | 3.3% |

The 2 others: "getRequest split childIds" (no session, 2026-10-16 20:38) and "accepted limits known and accepted" (2026-10-17 21:39). The fill is 94% of all searches and 93% of the zeros. Of the 3 zeros in the last 200, 2 are fill and 1 is not. The fill agents search once per claim before they send it, on terms that are often not in the wiki yet. That is the expected use of a search that finds a gap.

**A fault of the search: no.** The wiki config (`wikifact.json`) sets no `searchCap` and no `relevanceFloor`, so the defaults apply: cap 10, floor 0.31. I ran the 27 queries again with `search()` on the copy (973 facts):

- 25 return 1 to 10 results.
- 2 still return none: "failAttempt MAX_ATTEMPTS attempts" and "definition tooltip at most 360 px wide data-definition hover focus". Both are identifier lists, and no fact holds them.
- With the floor off (the agent form of `search`), all 27 return 20 results. So the floor removes weak matches, as designed, and no query dies for another reason.
- The wiki had 184 facts at the first zero and 269 to 315 at the fill zeros. The fill added most of the 973 facts.

**The minted ids: no.** `recordSearch` writes `result_count` as the length of `results` in the same transaction as the `search_results` rows, and `searchAndLog` writes a row once per call. In the copy no two searches of 1 session have the same query within 2 s, and only 2 (session, query) pairs repeat at all. `result_count` is 0 for 27 searches and 1 to 10 for the other 922, with 10 (the cap) for 671. I checked the stored count against the `search_results` rows only for the 10 searches that have rows.

## Another finding

939 of 949 searches have no `search_results` rows. The minted ids shipped on 2026-10-18 01:34, so only the 10 searches after it carry rows, and 453 older reads have a NULL `ref`. `result_count` is kept, so the no-result count is right. But the "Reads per search" histogram and "Searches with no read" count each search with results and no rows as 0 reads, for 190 of the last 200 searches. That share is not a measure of use until the log holds more searches after 2026-10-18. It matches the wait of B-004 and B-006 for searches from agents on questions.

## Fix

No bug, so no change in `src/`. Two optional changes are outside this item: show the count with one decimal when it is under 10%, and make `noResultLevel` green under a share. Both need an owner decision on the rule, because the design says "ok at 0, warning over 0" ([design/console.md](../design/console.md), "The signals").
