# Ingest documents

Requirements layer. The design is in [../design/ingest.md](../design/ingest.md).

User: operator. The roles are defined in [README.md](README.md#roles).

## Goal

The operator wants to fill a new wiki from the documents of its shared system at a lower cost than agents that read the documents and submit 1 claim at a time.

## Use cases

1. Fill a new, empty wiki from the docs and the source files of its shared system.
2. Add the facts of a new document to a wiki.

## Requirements

| Name               | Contract                                                                                                                                                                                                     | Proof today | Gap                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claims from a file | The operator names a wiki and 1 or more text files. A model reads each file and returns its claims, 1 claim each, with the file and the line that states it. | The requirement test. | The quality of the extraction rests on the model. The study of 2026-10-27 measured 98.5% of the fill claims found in each run and 0 wrong claims in 100 (Sonnet 5.5), on 10 files only. |
| One request each   | Each extracted claim enters the queue as 1 request, with the file and the line as its justification, and goes through the same process as a submission of a consumer. | The requirement test. | None                                                                                                                                                                                       |
| Cost shown         | The operator sees the model cost of the extraction and the count of the claims queued from each file.                                                                                                       | The requirement test. | None                                                                                                                                                                                       |

## Out of scope

- Documents that are not text (PDF, images).
- A tool for consumers. A consumer submits what it saw with `requestChange`.
