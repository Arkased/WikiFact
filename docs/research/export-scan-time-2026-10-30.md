# Time of the export scan, 2026-10-30

Issue #111. The measurement of the scan of `findTerms` (`scripts/lib/export-terms.ts`, [The scan](../technical/publication.md)) on a large text. A test reads no clock ([code standard](../code-standard.md), section 8), so the time is kept here. All numbers come from one machine (Windows 10 Home 10.0.19045, Node.js v24.14.1) on 30 October 2026, from the code of the branch `issue-111-export-public`, with the table of the HTML entities as a `Map` and the line of a match from a binary search.

## Result

- A text of 100,000 lines that all hit (999,999 characters) takes 1.5 to 1.6 s.
- A text of 1 MB (1,000,000 characters) with no hit takes about 0.52 s.

## Times

Each text was scanned 3 times in one process, for the one term `Acme Corp`. The time is `performance.now()` around the call of `findTerms`.

| Text | Run 1 | Run 2 | Run 3 | Hits |
|---|---|---|---|---|
| 100,000 lines of `Acme Corp` (999,999 characters) | 1,601 ms | 1,535 ms | 1,617 ms | 100,000 |
| 1 MB of filler lines with no match (1,000,000 characters) | 520 ms | 514 ms | 528 ms | 0 |

## Method

The 1 MB text is the line `lorem ipsum dolor sit amet ` repeated 40 times plus a line break, repeated and cut to 1,000,000 characters. The script is not in the repo. The command, from the root of the checkout:

```
node --import tsx <script>.ts
```

The script builds the 2 texts, imports `findTerms` and prints the time of each of the 3 calls per text.
