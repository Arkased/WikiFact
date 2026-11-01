# Ingest documents

Design layer. The requirements are in [../requirements/ingest.md](../requirements/ingest.md). The technical details are in [../technical/ingest.md](../technical/ingest.md).

## Approach

The operator runs 1 command with a wiki name and a list of files. For each part of a file, 1 model call reads the part and returns its claims. A short file is 1 part. The command then sends each claim to the wiki with `requestChange`, as a consumer does. The update worker processes each claim through the whole process ([updates.md](updates.md)): the claim check, the scope match, the judgment and the draft.

The command adds no step to the worker and no path into the store. The only new part is the extraction call. So the quality checks of a submission (the claim check, the duplicate judgment) also apply to each extracted claim.

## How the design meets each requirement

### Claims from a file

The command reads each file as text and numbers its lines. 1 model call per part of a file gets the part with its line numbers and returns a list of claims. Each claim has its text and the line that states it. The prompt asks for 1 attribute per claim, with each claim written to stand alone. The prompt is the extraction prompt of the study of 2026-10-27 ([research note](../research/document-ingestion-2026-10-27.md#the-extraction-prompt)).

The call uses Sonnet. Sonnet found 98.5% of the fill claims in each run, and Haiku found 78.2%. The extraction is less than 1% of the cost of a fact write, so the cheaper model saves almost nothing.

2 files never share 1 call. A call with several small files cost the same and lost facts (the study, section "Batches"). A long file is read in parts, so the answer of each call stays under its token limit. Each part keeps the line numbers of the file.

### One request each

The command sends each claim with `requestChange` on the management endpoint `/mcp` of the service, with the `wiki` argument:

- the change: the claim text,
- the justification: `Stated in <file> at line <N>.`, with the path of the file relative to the folder where the command runs.

This is the path of a consumer. The worker cannot tell an extracted claim from the claim of an agent. The checks of "Bad input refused" apply to each claim.

The claims of 1 file go to the queue in the order of their lines. The command waits for no outcome. The operator watches the queue on the console.

### Cost shown

The command prints 1 line per file: the file, the count of claims queued, and the model cost of the extraction call in USD. At the end it prints the totals. The cost of the worker for each claim shows on the console, as for every request.

## Decisions

| Decision | Reason |
|---|---|
| Each claim goes through the whole process (path A of the study). The extraction does not draft the facts. | The drafts of path C skipped the claim check, and 23% of them held more than 1 claim, against 7% for path A. Path C saved only 10%. |
| The command sends with `requestChange` through `/mcp`, not into the store. | 1 path for all submissions. The worker, the checks and the console need no change. |
| No batch of claims. | A batch of claims (path B) cost $0.069 per fact write, against $0.048 for 1 claim per request. |
| An operator command, not an MCP tool. | The requirement is the first fill of a wiki, which the operator starts. A consumer submits what it saw with `requestChange`. |
