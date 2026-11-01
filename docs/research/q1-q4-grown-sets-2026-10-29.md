# Q1 and Q4 on their grown sets (2026-10-29, #106)

#103 grew the Q1 set to 82 cases and the Q4 set to 88 cases. The summary ignores an entry with fewer cases than its set, so each configuration of the last summary (`summary-2026-10-27T18-48-53.000Z.json`) was measured again: 3 runs, `--full`, on the grown sets. The pass bar is a mean of 90% or more with no run under 85%. The interval is the 95% Wilson interval over all answers of the 3 runs. The cost is the estimate for the 3 runs.

The summary: `eval/questions/results/summary-2026-10-29T21-27-43.482Z.json`.

## Q1 (82 cases)

| Configuration | Mean  | Interval      | Lowest run | Cost (3 runs) | Bar  | Result file                                                     |
| ------------- | ----- | ------------- | ---------- | ------------- | ---- | --------------------------------------------------------------- |
| Haiku low     | 90.7% | 86.4% - 93.7% | 90.2%      | $0.07         | pass | `eval/questions/results/2026-10-29-g106-q1-haiku-low.json`      |
| Haiku medium  | 89.4% | 85.0% - 92.7% | 87.8%      | $0.06         | fail | `eval/questions/results/2026-10-29-g106-q1-haiku-medium.json`   |
| Sonnet low    | 83.3% | 78.2% - 87.5% | 81.7%      | $1.09         | fail | `eval/questions/results/2026-10-29-g106-q1-sonnet-low.json`     |
| Sonnet medium | 85.4% | 80.4% - 89.2% | 84.1%      | $0.88         | fail | `eval/questions/results/2026-10-29-g106-q1-sonnet-medium.json`  |
| Opus low      | 94.7% | 91.2% - 96.9% | 93.9%      | $2.33         | pass | `eval/questions/results/2026-10-29-g106-q1-opus-low.json`       |
| Opus medium   | 95.1% | 91.7% - 97.2% | 95.1%      | $2.62         | pass | `eval/questions/results/2026-10-29T20-45-20.020Z.json` (from #103) |

## Q4 (88 cases)

| Configuration | Mean  | Interval      | Lowest run | Cost (3 runs) | Bar  | Result file                                                     |
| ------------- | ----- | ------------- | ---------- | ------------- | ---- | --------------------------------------------------------------- |
| Haiku medium  | 85.2% | 80.4% - 89.0% | 83.0%      | $0.19         | fail | `eval/questions/results/2026-10-29-g106-q4-haiku-medium.json`   |
| Sonnet high   | 97.3% | 94.6% - 98.7% | 96.6%      | $2.79         | pass | `eval/questions/results/2026-10-29T20-45-20.495Z.json` (from #103) |
| Opus high     | 96.6% | 93.6% - 98.2% | 96.6%      | $5.59         | pass | `eval/questions/results/2026-10-29-g106-q4-opus-high.json`      |

## Preset changes

- Q1 `budget`: Haiku medium becomes Haiku low. Haiku low is the cheapest configuration that passes the bar (mean 90.7%, lowest run 90.2%). Haiku medium now fails on the grown set (mean 89.4%, lowest run 87.8%). The margin of Haiku low over the bar is thin, and its interval reaches down to 86.4%.
- Q1 `standard` and `premium`: no change. Opus medium has the best mean (95.1%); Opus low is within the interval.
- Q4 `budget`, `standard` and `premium`: no change. Sonnet high has the best mean (97.3%) and is cheaper than Opus high (96.6%).
- Q2 to Q10: no change.
