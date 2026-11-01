# The test of the reads per search, October 29, 2026

Research note of #6. The test of the reading of the reads per search on the Overview page ([design](../design/console.md), "The test of the reads per search"). Read-only on a copy of the live store. Times are UTC.

## Result

- The reading fails its test. The count of reads after a search does not tell whether the search found the answer.
- 0 reads agrees with "not found" in 11 of 20 searches (55%). 1 read agrees with "found" in 14 of 20 (70%). The bar is 80%.
- Only 2 searches had 3 or more reads. Both were labeled "found", not "misled". 2 searches give no verdict.
- So the reading of the reads per search and the color of "Searches with no read" go. The numbers stay as data.

## Method

1. A copy of the live store `wikifact`, taken at 03:10 with its WAL.
2. The population: the searches with results and minted ids, 174. 10 are left out: the 4 fill sessions of 2026-10-17, 03:36 to 05:36, and the searches from 2026-10-29 02:43 on, which are the usage tests of #2 and #98 and their research agents. 164 stay: 122 with 0 reads, 29 with 1, 11 with 2, 1 with 3 and 1 with 4.
3. A sample of 20 per count (0, 1, and 3 or more), all when fewer exist, with seed 1.
4. The labeler `claude-opus-5-5` (medium effort) got the query, the listed results with the headers of the version current at the search, and the full content of each read. It marked each search found, not found or misled, with 1 sentence of reason.
5. The script is `npm run reads-per-search` ([evaluation.md](../technical/evaluation.md)). The result file is `eval/reads-per-search-results/2026-10-29T03-10-38.621Z.json`. The run cost $0.78 for 42 labeler calls.

## Agreement

| Sample | Expected label | Agreed | Share | Verdict |
|---|---|---|---|---|
| 0 reads | not found | 11 of 20 | 55% | fails |
| 1 read | found | 14 of 20 | 70% | fails |
| 3 or more reads | misled | 0 of 2 | 0% | no verdict |

A first run at 03:01 used the newest header of each listed fact, not the header at the time of the search. It gave 10 of 20, 14 of 20 and 0 of 2. The review found the fault, and the run above replaced it.

## What it means

- 9 of 20 searches with 0 reads found the answer. The agent took it from the headers, or had no need to open a fact. The first usage note found the same mix: 3 of 6 searches with no read had the answer in the listed facts ([agent-usage-2026-10-16.md](agent-usage-2026-10-16.md)).
- 6 of 20 searches with 1 read did not answer: the agent opened a fact that did not hold the answer.
- The count of reads is a measure of behavior, not of quality. A reading of search quality needs a label, as in this test, or another signal.

## What is not covered

- 1 labeler, 1 run, 1 seed. The labels are not checked by a person.
- The samples are 20 searches each, so 1 search moves the share by 5 points.
- The case of 3 or more reads has 2 searches. It cannot be judged.
