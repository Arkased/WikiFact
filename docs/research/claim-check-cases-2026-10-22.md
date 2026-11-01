# Claim check: new cases, scores of the current prompt, and the rule that fails (2026-10-22)

Issue #21, step 1 of 2 (the section "Update: the 12 live cases" supersedes the counts below: 103 cases, 17 new). No prompt was changed. The orchestrator designs the change from this note.

## Result

- The claim check (Q7) gives opposite verdicts on the same kind of text, and the set shows it now: the 5 cases that could be rebuilt from the repo score 8 of 15 runs (53.3 percent) at the current preset (sonnet, medium) and 8 of 15 at sonnet low. The 91-case set scores 92.3 percent at both, so the old 86 cases hide the fault.
- The held-out half (45 cases, every case with an even number) scores 96.3 percent at sonnet medium and 94.1 percent at sonnet low. The tuning half scores 88.4 and 90.6 percent. These are the baseline that a prompt change must not lower on the held-out half.
- Only 5 of the 18 cases were added. The 12 cases of the bulk test of 2026-10-20 (7 on the 1-at-a-time path, 5 on the batch path) could not be rebuilt: their text is in the queue of the live wiki `wikifact`, and the read of that database was blocked in this run (auto mode classifier, "production read"). Neither the committed result files nor any note holds their text or the verdict of the opus judge. Section "The 12 cases that were missing" says what is needed.
- There is no group question for the claim check. Q7B was removed: the batch path runs Q7 for each request, and the group sets exist for Q11B only (`GROUP_QUESTIONS` in `eval/questions/group-sets.ts`). So there is one set to grow, `eval/questions/q7.json`, and the batch path is covered by it.
- The cause, from the text of the prompt and 24 probe calls (section "The rule that fails"): three rules overlap. The test for a compound ("a correction to one part would leave the other part standing, or one part could be true and the other false") is true for any two parts. The exemption ("one attribute whose value has several parts", "a list as the value") has no test of its own. The model decides by how it names the attribute, and names it differently from call to call.

## Update: the 12 live cases (step 1b, same day)

The 12 cases of the bulk test of 2026-10-20 are in the set as q7-92 to q7-103, group `real use`, label "one claim" for all 12 (the opus judge of the bulk test found the compound check wrong on each; for `14150CHK` and `56FG24S4` the right outcome of the pipeline was "duplicate", the claim check label is still "one claim"). Each carries `expect: {oneClaim: true}` with no `support` label, and the source in its note ("bulk test 2026-10-20, request <last 8 characters>"). The held-out half is the even numbers: q7-92, 94, 96, 98, 100, 102. The set is now 103 cases: 51 held-out, 52 tuning. No prompt was changed. Same command as above; result files `eval/questions/results/2026-10-22-claim-check-17cases-sonnet-medium.json` and `...-sonnet-low.json`.

| | sonnet medium | sonnet low |
| --- | --- | --- |
| 17 new cases (q7-87 to q7-103), 51 case runs | 47.1 percent | 58.8 percent |
| of those, the 12 live cases (36 case runs) | 44.4 percent (16 of 36) | 58.3 percent (21 of 36) |
| of those, the 5 of step 1 (15 case runs) | 53.3 percent (8 of 15) | 53.3 percent (8 of 15) |
| New cases in the held-out half (q7-88, 90, 92 to 102 even: 8 cases) | 54.2 percent | 58.3 percent |
| New cases in the tuning half (9 cases) | 40.7 percent | 59.3 percent |
| Held-out half, 51 cases | 90.2 percent | 91.5 percent |
| Tuning half, 52 cases | 82.7 percent | 86.5 percent |
| Held-out half, the old 43 cases (q7-02 to q7-86, even) | 96.9 percent | 97.7 percent |
| Tuning half, the old 43 cases | 91.5 percent | 92.2 percent |
| All 103 cases, mean of 3 runs | 86.4 percent (runs 88.3, 87.4, 83.5) | 89.0 percent (runs 86.4, 89.3, 91.3) |
| Cost of the run, 3 runs | 1.54 USD | 1.47 USD |

Both settings now fail the bar of the question test (a mean of 90 percent or more, no run under 85): medium has a run at 83.5 percent. The old 86 cases are unchanged (94.2 and 95.0 percent), so the fall is the 12 cases. The new baseline for a prompt change is the held-out half of 51 cases: 90.2 percent at medium and 91.5 percent at low, and the 43 old held-out cases at 96.9 and 97.7 percent.

Passes of the 12 in 6 runs (3 at medium, 3 at low), and the rule that the model's reason points to. The result files hold no reason (a result entry keeps the verdict and the pass rate, not the answer), so the reasons come from a separate probe: 3 calls per case at each setting, 72 calls, same prompt and settings, not in the table of cost. The probe verdicts differ from the scored runs in a few calls, as the cases are unstable.

| Case | Request | Text, short | Passes of 6 | Reason of the failing calls |
| --- | --- | --- | --- | --- |
| q7-92 (held) | `HHJ5PMBB` | a table: what it holds, and its primary key | 1 | "Two attributes" (what it holds, its primary key), "either could be wrong while the other stands" in 4 of 6 probe calls; the 2 passes call the key "part of the description" |
| q7-93 | `Z4PVC7Z8` | fact_version_refs, same shape | 2 | Two attributes, 5 of 6 probe calls |
| q7-94 (held) | `9KNJ6S54` | "replaced by" link, with an appositive that the use case is out of scope | 5 | None in 6 probe calls (the date and the scope read as context) |
| q7-95 | `D32AA11H` | the Schema 6 migration rebuilds two tables, each with its own reason | 0 | The "two parts" test, and the sign "two subjects": "each with its own rebuild reason, so one could be wrong while the other stands", 6 of 6 |
| q7-96 (held) | `JBG3Q5ER` | fact_versions_fts: tokenizer, external content | 2 | Two attributes (tokenizer, external-content setup) in 3 of 6; the other 3 name one attribute, "its definition", with several parts |
| q7-97 | `6YFNF23Z` | fact_versions_vec: what it holds, and who reads it (parenthesis) | 0 | Two attributes (what it holds, what reads it), 6 of 6 |
| q7-98 (held) | `2KBATXDN` | the release captures the tag and checks its format | 0 | Two attributes or behaviors (capture, check), 6 of 6 |
| q7-99 | `FZ3Y8NXC` | an accepted miss, and what the query returns | 6 | One call of 6 gave "two claims" (the "two parts" test); 5 gave one claim with the result as context |
| q7-100 (held) | `83F2SZVA` | a "no longer true" claim is a duplicate, writes nothing, gets no event, because confidence is 0 | 6 | One call of 6 gave "three separate outcomes that could each be wrong" (the "two parts" test) |
| q7-101 | `E12B33YM` | the management endpoint has 4 + 4 tools | 5 | None in 6 probe calls ("a list with a multi-part value"); the one scored miss has no reason |
| q7-102 (held) | `14150CHK` | a table is a copy of the latest row of a versions table, kept in the same transaction | 4 | One call of 6: two attributes (what it copies, when it is kept) |
| q7-103 | `56FG24S4` | the worker's two transports | 6 | None |

Reading: of the 12, 6 fail in most runs (q7-92, 93, 95, 96, 97, 98, at 0 to 2 of 6) and all of them quote the "two attributes" sign or the "two parts" test; none quotes "a list as the value". The other 6 pass in 4 to 6 of 6 and fail by a rare call that quotes the same test. So the two rules that fail on the 12 are "two attributes" (q7-92, 93, 96, 97, 98, 102) and the "two parts" test (q7-95, 99, 100); the "list as the value" rule is the fault of q7-87 only. The cause of section "The rule that fails", fault 2, is the one that the live cases show: the same text is "two attributes" in one call and "one attribute whose value has several parts" in the next (q7-96, q7-92).

## Held-out rule

The rule of [Test plan](../technical/questions.md#test-plan) (split into a tuning half and a held-out half; keep a change only when the held-out half does not drop) had no build. This step adds the smallest build:

- `Case.heldOut` (`eval/questions/sets.ts`), optional; absent means the tuning half.
- `eval/questions/q7.json`: `"heldOut": true` on each case whose number is even (q7-02, q7-04, ..., q7-90), 45 of 91. The split is by number, so it was fixed before any score was read, and it holds both groups (designed and real use) in the same share.
- The runner does not report the halves yet. The scores below come from `casePassRate` of the result files, by a script outside the repo. A report by half in the runner is a follow-up.

## The 5 cases added

Format of the set: real-use cases carry the subject of the wiki `wikifact` in `ctx`, the group `real use`, and a note with the source. All 5 come from [bulk-test-real-2026-10-22.md](bulk-test-real-2026-10-22.md) (issue #32), the requests marked `[CC]`. The request ids are written with the last 6 characters.

| Case | Label | Source request | What the two paths did | Text |
| --- | --- | --- | --- | --- |
| q7-87 | compound (3 claims) | `W4G897` | 1 at a time accepted it as one fact; the batch path split it | "The console flags a read when the share of searches with 0 reads is over 0.5 (NO_READ_SHARE), the share with 3 or more reads is over 0.3 (MANY_READS_SHARE), or the share of sessions with no search is over 0.3 (NO_SEARCH_SHARE)." |
| q7-88 | one claim, held out | `AMBNHH` | 1 at a time split it; the batch path passed it | "The question Q4 runs on opus with high effort in the question tests." |
| q7-89 | one claim | `AMBNHM` | 1 at a time passed it; the batch path split it | "The question Q12 runs on sonnet with low effort in the question tests." |
| q7-90 | one claim, held out | `H93PA2` | 1 at a time split it; the batch path passed it | "ESLint keeps no cache in the check, because its type-checked rules read other files." |
| q7-91 | one claim | `GQ45AD` | the batch path split it; 1 at a time did not | "A cache for ESLint would miss an error that a change in another file causes, so the repo uses none." |

The texts of q7-88 to q7-91 are the claims of `fakes/bulk-claims.ts` (the test wiki of the bulk test builds its submissions from them), with the justification of that file. The label of q7-87 is the label of the issue (compound). The notes of the bulk test do not give a judge verdict for the other four, only that the two paths disagreed; the label "one claim" is the label of the issue for a subject with two attributes, a reason or a configuration, and it is the orchestrator's to confirm (confirmed: the labels of q7-88 to q7-91 are "one claim"). A case that the labeler is not sure of belongs in the set with "unclear" in its note; none of the four is marked, since the verdict of the issue is the same for all of them.

## The 12 cases that were missing (now in the set, see "Update")

This section is the state of step 1. The 12 outcomes of the bulk test of 2026-10-20 are requests of the live wiki queue (`game.sqlite` of the wiki `wikifact`, 1,747 queued at the time). `eval/bulk/results/2026-10-20T23-30-53.833Z.json` keeps the request ids, the outcomes and, for a rejected request, the reject reason of the check; it keeps no change text. The verdict of the opus judge is in no file of the repo. To finish the step, the owner (or an agent with the grant) runs a read-only copy of the queue (`.backup` of the SQLite file, as `scripts/rebuild-wiki.ts` does) and reads the `change` and `justification` of the requests below. A reading of the reject reasons in the result file gives 12 candidates, the 7 and the 5 of the issue (ids by their last 8 characters):

- The 1-at-a-time path rejected as compound, the batch path accepted it or called it duplicate (7): `HHJ5PMBB` (a table, what it holds and its primary key), `Z4PVC7Z8` (the same shape), `9KNJ6S54` (what a link served and that the use case is out of scope), `D32AA11H` (two tables), `JBG3Q5ER` (fact_versions_fts, its tokenizer and its external content), `6YFNF23Z` (a table and the feature that reads it), `2KBATXDN` (the release captures the tag and checks its format).
- The batch path rejected as compound, the 1-at-a-time path did not (5): `FZ3Y8NXC`, `83F2SZVA` and `E12B33YM` (the 1-at-a-time path accepted these three), `14150CHK` and `56FG24S4` (the 1-at-a-time path called these two duplicate: the "right outcome was duplicate" cases of the issue, if the judge agrees).

That list is a reading of the reject reasons, not the list of the judge. The labels need the verdict of the judge.

## Scores of the current prompt

Command: `npm run questions -- Q7 --model claude-sonnet-5-5 --effort medium --runs 3` (and `--effort low`). The Q7 pick of the `standard` preset is sonnet at medium effort (`config/presets.json`); sonnet at low effort is the `budget` pick and the setting in which the calls of the bulk test ran. Transport: the CLI. Result files: `eval/questions/results/2026-10-22-claim-check-cases-sonnet-medium.json` and `...-sonnet-low.json`.

| | sonnet medium (standard) | sonnet low (budget) |
| --- | --- | --- |
| All 91 cases, mean of 3 runs | 92.3 percent (runs 93.4, 90.1, 93.4) | 92.3 percent (runs 91.2, 91.2, 94.5) |
| The 5 new cases (15 case runs) | 53.3 percent (8 of 15) | 53.3 percent (8 of 15) |
| Held-out half, 45 cases | 96.3 percent | 94.1 percent |
| Held-out half without the 2 new cases, 43 cases | 96.9 percent | 96.1 percent |
| Tuning half, 46 cases | 88.4 percent | 90.6 percent |
| Designed cases (56) | 100 percent | 100 percent |
| Real-use cases before this step (30) | 84.4 percent | 84.4 percent |
| Cases unstable across the 3 runs | 10 | 10 |
| Cost of the run, 3 runs | 1.52 USD | 1.22 USD |

Pass rate of the new cases, per case, in 3 runs:

| Case | sonnet medium | sonnet low |
| --- | --- | --- |
| q7-87 (compound, 3 thresholds) | 0 of 3 | 1 of 3 |
| q7-88 (Q4 opus high) | 3 of 3 | 2 of 3 |
| q7-89 (Q12 sonnet low) | 2 of 3 | 3 of 3 |
| q7-90 (ESLint, because) | 2 of 3 | 1 of 3 |
| q7-91 (ESLint, so) | 1 of 3 | 1 of 3 |

The other cases under 100 percent at sonnet medium, all real use: q7-45, q7-49, q7-57, q7-61, q7-68, q7-69 (a single claim called compound, or a compound called single, by turns), q7-60 and q7-67 (never right: q7-67 asks `report` for a justification that reads as `observation`, which is a label to review). The bar of the question test is 90 percent or more with no run under 85: both configurations pass it on the whole set, as they did before. The fault shows on the real-use cases, not in the mean.

A separate probe (3 calls each on q7-87, 89, 90, 91, 45, 49, 57, 68 at sonnet medium, the `reason` field read; the cost of the 24 calls is not in the table) gave the verdicts that the next section quotes.

## The rule that fails

The prompt is `CLAIM_CHECK_RULES` in `src/updates/questions/specs/q7.ts`. Rule 1 reads:

> A claim has one subject, one attribute and one value. The change is not one claim (oneClaim = false) when it holds two claims, that is, when a correction to one part would leave the other part standing, or when one part could be true and the other false. Signs: two subjects with their own values ("Creepers and zombies do 10 damage"), two attributes ("Skeletons are hostile and spawn at night"), a main claim with its own exception ("Creepers explode, unless a cat is near"), two sentences that say different things. [...] Not compound: one attribute whose value has several parts ("A torch needs 1 coal and 1 stick and makes 4 torches" is one recipe), a list as the value, a condition that is part of the measurement ("A charged creeper kills an unarmored player in one hit"), and context around a single claim ("In version 1.20, on normal difficulty, creepers do 10 damage").

Three faults, each with the evidence of the probe:

1. The compound test fires on any two parts. "One part could be true and the other false" holds for the two halves of a recipe, a table and its key, a rule and its reason, a model and its effort. Nothing in the rule says when two parts that could differ are still one claim. The probe on q7-90 (`ESLint keeps no cache, because its type-checked rules read other files`) gave "a main fact (no ESLint cache) and a separate reason [...] either could be wrong while the other stands" in 2 of 3 calls, and "the 'because' clause only gives the rationale" in the third. q7-91 (`..., so the repo uses none`) gave "either could be true while the other is false" in 2 of 3. The wording of the test quoted by the model is the wording of the prompt. There is no line on a reason or a consequence after "because" or "so"; the only context the prompt exempts is the version, the difficulty and the measurement condition.
2. "Two attributes" is a sign of compound, with the example "Skeletons are hostile and spawn at night", and "one attribute whose value has several parts" is the exemption. The text does not say how to tell an attribute from a part of a value. So "1 subject with 2 attributes" (a table, what it holds and its primary key; a decision and its scope) reads as compound under the sign, and passes under the exemption, by the name that the model gives the attribute. On q7-89 the model wrote "one attribute, its run configuration, whose value has two parts (sonnet, low effort)" in 3 of 3 probe calls. In the run of the test the same text failed in 1 of 3 calls. The 7 rejects of the 1-at-a-time path in the bulk test are of this shape (the reject reasons read "two attributes of the table, its contents and its primary key, and either could be wrong while the other stands"), and the sign "two attributes" is the rule that they quote.
3. "A list as the value" has no limit, and it let the 3 thresholds through. The probe on q7-87 gave "one rule (when the console flags a read) whose value is a list of three threshold conditions" and "one attribute (when it flags a read), with a value made of three threshold conditions, which is a multi-part value" in 3 of 3 calls. The three thresholds measure three different shares (searches with 0 reads, searches with 3 or more reads, sessions with no search), each with its own constant, and are joined by "or". The prompt does not tell a list of the same measure for several subjects (the due threshold of each finder, q7-49) from a list of different measures. On q7-49 the same prompt gave "a list of per-type values" in 2 of 3 calls and "four finders each have their own threshold" in 1.

One more cause, in the shape of the answer, not in the rule: `q7Fields` orders `oneClaim`, `claims`, `support`, `reason`. The verdict comes before its reason, so the reason is written for a verdict that is already set. The quotes above show a reason that matches the verdict each time, whichever verdict it is.

## Proposed changes (not applied)

The rule of the question tests holds: a change is kept only when the held-out half does not drop below the new baseline, the held-out half of 51 cases (90.2 percent at sonnet medium, 91.5 percent at sonnet low; the 96.3 and 94.1 percent of the 45 cases of step 1 are superseded), and the 3 runs show no unstable case that was stable.

1. A reason or a consequence is not a second claim. Add to "Not compound": "a claim with its reason or its consequence after 'because', 'since' or 'so' (the reason says why the claim holds; it is not a claim to correct apart)". Should fix: q7-90, q7-91, and the ESLint requests `H93PA2` and `GQ45AD` of the bulk test. Can break: q7-60 ("... moved to the .archive/ folder, from which unarchiveWiki or a human can restore it": a relative clause with its own claim, label compound), the compound cases whose second half starts with "so" or "because" in the designed set (the held-out half has to be read for these before the run), and q7-58 (a refusal with its remedy, label single, which should only gain).
2. Tell the list of one measure from a list of different measures. Replace "a list as the value" with "a list as the value: the same measure for each item (the due threshold of each finder, the damage of each sword). Different measures, each with its own name or constant, joined by 'and' or 'or', are several claims." Should fix: q7-87 and request `W4G897` (the 3 thresholds). Can break: q7-49 (4 thresholds of one measure, label single, the case that the new wording is written to keep), q7-57 (the red rule and the yellow rule of one row, label single; the probe splits it in 3 of 3 calls today, so it may stay wrong), q7-62, q7-48 and q7-64 (a mechanism with a decrease, a floor, a step and a start).
3. Name the attribute test, and move `reason` before `oneClaim` in `q7Fields`. In the text: "Two attributes of one subject are one claim when the second one gives the first its configuration, its scope or its key (a model and its effort, a table and its primary key, a decision and its scope); they are two claims when a reader would look each up alone (hostile, and spawns at night)." In the schema: `reason` first. Should fix: q7-88, q7-89 (the model and effort pairs), and the 1-at-a-time rejects of a table and its key and of a decision and its scope, once their texts are in the set. Can break: q7-73 to q7-81 (the designed split cases with two attributes, such as "20 health and 20 hunger"), and q7-50 and q7-69 (several attributes, labeled compound), where the new sentence gives the model a reason to pass them; the "look each up alone" test is the only guard. This is the weakest of the three and has no measurement behind it: the 7 texts are missing. The move of `reason` is a mechanical change, as the global rule asks, but the probe did not test it.

### The three changes against the 17 new cases (after the 12 are in the set)

| Change | Should fix among the 17 | Should keep (already passing, at risk) | Not reached |
| --- | --- | --- | --- |
| 1. A reason or a consequence is not a second claim | q7-90, q7-91 (2 cases). Of the 12, none fails on a reason: it guards q7-99 (cause of the miss) and q7-100 ("because confidence is 0"), whose rare splits are not on the "because" clause | q7-99, q7-100, q7-94 | the other 13 |
| 2. A list of one measure against a list of different measures | q7-87 (1 case). None of the 12 | q7-101 (4 + 4 tools, a list of one kind), q7-103 (two branches of one rule), q7-49 | the other 15 |
| 3. Name the attribute test (the second attribute gives the first its configuration, scope or key); `reason` before `oneClaim` | q7-88, q7-89 (step 1); of the 12: q7-92 and q7-93 (table and primary key), q7-96 (table and its external-content setup), q7-102 (a copy and when it is kept up to date), and q7-98 (capture and check of the tag) only if "configuration" is read widely: 6 to 7 of the 17 | q7-94 (decision and scope), q7-101, q7-103 | q7-95 (two tables in one migration), q7-97 (what a table holds and who reads it): the test does not cover them |

Together the three should reach 9 to 10 of the 17 new cases (q7-87, 88, 89, 90, 91, 92, 93, 96, 102, and q7-98 at most). Three stay out of reach: q7-95 and q7-97 for sure, q7-98 likely. Open, for the orchestrator: a fourth change, "a statement about two subjects or two properties joined by one operation or one document line is one claim when it is one sentence of the source", would aim at q7-95 and q7-97; the label of these two is the judge's, and the "two parts" test as it stands is what it contradicts. No data tests it. The 12 cases are 51.4 percent today, so the bar of the question test is out of reach for change 1 and 2 alone, and the real gain is change 3.

The order to try: 1 first (fewest cases at risk, the cause is the clearest), then 3 (it has the most cases to fix, 6 to 7 of the 17, with its risk on q7-73 to q7-81, q7-50 and q7-69, now measured against 12 cases), then 2.

## What the next step needs

1. The labels of q7-88 to q7-91 are confirmed: a model with its effort is 1 configuration; a claim with its reason or its consequence is 1 claim.
2. A report of the halves in the runner, so that the held-out score is a line of the output and not a script (built in step 2).

## Step 2: the prompt change

Issue #21, step 2. The prompt of Q7 changed in 3 steps, each tried alone, in the order of the held-out rule, and each measured with `npm run questions -- Q7 --model claude-sonnet-5-5 --effort medium --runs 3` and the same with `--effort low` (transport: the CLI, 103 cases). A step is kept when the held-out half (51 cases) does not drop below its score before the step. The runner reports the halves now, so the scores are lines of the output. Result files are in `eval/questions/results/`: `2026-10-23T00-24-46.037Z.json` and `...00-27-48.149Z.json` (step 1), `...00-31-16.845Z.json` and `...00-35-10.159Z.json` (step 2), `...00-38-50.910Z.json` and `...00-42-18.385Z.json` (step 3).

The text of each rule is the text of [submit.md](../design/submit.md), "One claim, No beliefs". In the prompt each rule went into the "Not compound" list of rule 1 of `CLAIM_CHECK_RULES`.

### Scores

Held-out is the half of 51 cases (the even numbers), tuning the half of 52. Mean and worst run are over all 103 cases. The cost is of the 3 runs.

| Step | Effort | Held-out | Tuning | Mean | Worst run | Cost (USD) | Kept |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Before (step 1b baseline) | medium | 90.2 | 82.7 | 86.4 | 83.5 | 1.54 | |
| | low | 91.5 | 86.5 | 89.0 | 86.4 | 1.47 | |
| 1. `reason` before `oneClaim`; a reason or a consequence is part of the claim | medium | 93.5 | 88.5 | 90.9 | 90.3 | 1.80 | yes (up from 90.2) |
| | low | 91.5 | 88.5 | 90.0 | 89.3 | 1.45 | yes (equal to 91.5) |
| 2. The configuration, the scope or the key of an attribute is part of it | medium | 94.1 | 91.7 | 92.9 | 92.2 | 1.72 | yes (up from 93.5) |
| | low | 92.8 | 89.1 | 90.9 | 89.3 | 1.40 | yes (up from 91.5) |
| 3. A list is 1 claim only when it holds 1 measure (in place of "a list as the value") | medium | 92.8 | 92.3 | 92.6 | 92.2 | 1.82 | no (under 94.1) |
| | low | 91.5 | 92.9 | 92.2 | 91.3 | 1.42 | no (under 92.8) |

The cost of the 6 runs of this step is 9.59 USD.

### Steps kept and reverted

- Step 1 kept. At low the held-out half equals the half before the step (91.5), so it does not drop. It cuts the failures on the ESLint cases (q7-90 and q7-91 pass 3 of 3 in both efforts) and lifts the whole set by 4.5 points at medium.
- Step 2 kept. It lifts the held-out half at both efforts and lifts q7-92, q7-93 and q7-96 (the table and its key, the table and its external-content setup) to 3 of 3 in both efforts.
- Step 3 reverted. The held-out half falls under its score before the step at both efforts (92.8 against 94.1 at medium, 91.5 against 92.8 at low), although the tuning half and the mean of the 103 cases rose. Under the held-out rule that is a fit to the tuning half. The rule "a list is 1 claim only when it holds 1 measure" is not in the prompt. q7-87 fails with or without it (0 of 3 in every run), so the rule did not reach its aim either.

The kept prompt is steps 1 and 2.

### Where the kept prompt stands

| | sonnet medium (standard) | sonnet low (budget) |
| --- | --- | --- |
| Mean of 3 runs | 92.9 percent | 90.9 percent |
| Runs | 93.2, 92.2, 93.2 | 89.3, 91.3, 92.2 |
| Held-out half | 94.1 percent | 92.8 percent |
| Tuning half | 91.7 percent | 89.1 percent |

The bar of the question test (mean 90 percent or more, no run under 85) is met at both efforts, and at the standard pick (sonnet, medium) with 2.9 points of margin on the mean and 7.2 on the worst run.

### The 17 new cases that still fail (kept prompt)

Passes in 3 runs, medium then low:

| Case | Passes | Shape |
| --- | --- | --- |
| q7-87 | 0 of 3, 0 of 3 | 3 thresholds, each its own constant, joined by "or" (the aim of step 3, which did not fix it) |
| q7-95 | 2 of 3, 1 of 3 | the Schema 6 migration rebuilds two tables, each with its own reason |
| q7-97 | 0 of 3, 0 of 3 | fact_versions_vec: what it holds, and who reads it |
| q7-98 | 0 of 3, 0 of 3 | the release captures the tag and checks its format |

Unstable in the kept runs (the verdict changes between runs): q7-92, q7-93, q7-95, q7-97, q7-102 at medium; q7-92, q7-95, q7-96, q7-97, q7-99, q7-102, q7-103 at low. The old cases that miss in both efforts are q7-60 (a relative clause with its own claim), q7-67 (a label to review: `report` against `observation`), q7-69 and q7-70; q7-57 misses at low. q7-95 and q7-97 are the two cases that the note named out of reach of the 3 rules, and q7-98 is the one the rule of the configuration reaches only if "configuration" is read widely. A fourth rule for them is open (see "Proposed changes"); no data tests it.

### Other

- `npm run questions -- summarize` fails before it writes: "Q11B: no group size passes the bar near the single question; nothing was written". By its code (`chooseSizes`) the check compares the Q11B entries with the single Q11, not Q7, and this step changed no Q11 or Q11B code; it was not run on a clean `build` to confirm that it fails there too. So `config/presets.json` is not rewritten, and the Q7 pick of the presets stays what it was. The cause is for the owner to settle (a new measurement of Q11B, or of its comparison with Q11).
