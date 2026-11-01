# Data model

Design layer. No feature owns the data model: every feature uses it. The technical details are in [../technical/storage.md](../technical/storage.md).

## Approach

A wiki holds facts. A fact holds 1 claim. Nothing is overwritten: each change writes a new version of each fact that it changes. Each change gets 1 sequence number, and that number names 1 state of the whole wiki.

The model serves 2 product requirements:

1. A consumer can tell how much to trust each fact. A page holds many claims of different standing, so trust attaches to 1 claim, not to a page.
2. AI agents add, correct and delete facts with no person in the loop. Full history lets a later change see what an earlier change did, and why.

## Fact

A fact is the smallest unit. It holds 1 claim, and every change acts on a whole fact. A fact has an id and 1 or more versions. Its latest version is its current state.

The scope of a fact is its identity. The header names the scope: what the fact is about, not the claim ("Creeper damage"). The wiki holds 1 fact per scope. So a second claim in the same scope is a correction of the fact, not a new fact. A second submission of the same claim writes no second fact.

The content is the claim ("Creepers do 10 damage"). The content:

- holds 1 claim,
- is short, about 10 to 20 words,
- names its subject and uses no pronouns,

so that a reader can act on it alone. A consumer cannot act on a header alone. So every use of a fact goes through a read of the full fact, and the wiki counts the same event for every fact.

Confidence and usefulness are not fields. The wiki computes them from the versions and their events, at read time. Each event loses weight with age. A low confidence means "stale", not "wrong". The number of corrections of a fact does not lower its score: a fact that changes often tracks a system that changes often.

## Version

A correction or a deletion writes a new version. A version holds:

- the header and the content,
- the justification,
- the references,
- the reason of the update agent for the change,
- the sequence number of the change that wrote it, and the time,
- the events on it: each read by a consumer, and each confirmation by a duplicate submission,
- a deletion mark.

A fact is deleted when its latest version carries the deletion mark. The justification of that version is the reason for the deletion.

The justification is the text of the submitter, stored as sent. It is prose, and it names other facts by header, not by id. The update agent never rewrites it, because the submission is the only evidence that enters the wiki. A version that the update agent derived from other facts, with no new observation, has an empty justification. Its references name the facts that hold the evidence.

## References

The references of a version are the ids of the facts that the version depends on. The update agent fills them from the facts that it used. A reference means only "depends on": if fact A references fact B, a change to B puts A in question. So the worker checks A again when B changes.

A deletion version holds no references. A link from a deleted fact to the fact that replaced it serves only a consumer that keeps a fact id and reads it later. That use case is out of scope. The change that deleted the fact shows what replaced it.

## Sequence number

Each applied change gets the next number of 1 global sequence. Every version that the change writes carries that number. The sequence number N names 1 state of the whole wiki: for each fact, its latest version at or below N.

## Decisions

| Decision | Reason |
| --- | --- |
| 1 fact holds 1 claim. | Trust attaches to 1 claim. A page holds claims of different standing. |
| The header is the scope, and 1 scope holds 1 fact. | A second claim in the same scope is then a correction, so 2 facts cannot drift apart. |
| Nothing is overwritten. Each change writes new versions. | A later change sees the history and the evidence of each fact. |
| The justification is stored as sent. A derived version has none. | The submission is the only evidence that enters the wiki. A rewording by a model replaces evidence with inference. |
| Confidence and usefulness are computed from events at read time, not stored. | The value changes with time alone, by the decay. |
| The number of corrections does not lower confidence. | A fact that changes often tracks a system that changes often. |
| A reference means only "depends on". A deletion version holds none. | A second meaning ("replaced by") made a revived fact depend on facts that it did not depend on. |
| 1 global sequence number per change. | 1 number names 1 state of the whole wiki. |

## Open points

- The source on confidence also lists an uncorrected read as a weak confirmation. The weight of that event starts at 0, and a correction run with no observation in its tasks must set it. Until then, a read does not raise confidence.
