# Ingest documents

Technical layer. The requirements are in [../requirements/ingest.md](../requirements/ingest.md). The design is in [../design/ingest.md](../design/ingest.md).

## Command

```
npm run ingest -- --wiki <name> <file> [<file> ...]
```

- `--wiki` is required. A wiki that the service does not hold is an error before any model call.
- Each file must exist and be text (UTF-8). A file that does not exist, or that is not UTF-8, gets 1 error line, and the command continues with the next file. A file has no size limit: a long file is read in parts (see "Extraction call").
- The command needs the service to run. It reaches the service at the URL of the local service, as the other operator commands do.
- The exit code is 0 when every file was read and every claim was queued, else 1.

## Extraction call

- 1 call per part of a file, with the model transport of the service and the `standard` preset model Sonnet 5.5 at low effort.
- Parts: a file of at most `MAX_PART_BYTES` (20,000) bytes of UTF-8 is 1 part. A longer file is split into parts of at most 20,000 bytes (the lines and their line breaks), each ending at a line break; a single line longer than the limit is a part of its own (`splitParts`). The reason: the densest file of the study (`docs/technical/lookup.md`, 17,217 bytes) gave 98 claims in 7,718 output tokens, about 0.45 output tokens per input byte. 20,000 bytes is then about 9,000 tokens, which leaves room under the answer limit `LONG_MAX_TOKENS` (16,000).
- System prompt: the extraction prompt of the [research note](../research/document-ingestion-2026-10-27.md#the-extraction-prompt), word for word.
- User message: `File: <path>`, then each line of the part as `N<TAB>text`. `N` is the line number in the whole file, so a part that starts at line 301 starts with `301<TAB>`.
- Answer: JSON `{ claims: [{ claim: string, line: number }] }`, checked with a zod schema. A claim with empty text, or with a line outside its part, is dropped and counted in the output line of the file.
- The claims of all parts of 1 file go to the queue in line order. A duplicate across parts goes to the duplicate judgment of the worker, as any duplicate does.
- The cost of the call comes from the answer of the transport. A call that hits the token limit, or whose answer fails the schema, still has its cost: it counts in the total and shows on the error line of the file.

## Queue

For each claim, in line order, 1 call of `requestChange` on `/mcp` with `wiki`, `change` = the claim, and `justification` = `Stated in <path> at line <N>.`. `<path>` is relative to the folder where the command runs, with `/` as separator.

## Output

1 line per file: `<path>: <claims queued> claims queued, <dropped> dropped, $<cost>`, with the cost summed over the parts. Then 1 line of totals. A file that fails (not read, not extracted) gets `<path>: error: <reason>` instead, with `, $<cost>` after the reason when a model call was paid for. A claim that `requestChange` refuses gets the line `<path>: line <N>: not queued (<reason>)`, where `<reason>` is the text of the tool result, and the file line adds `, <n> failed` before the cost.

## Code paths

- `scripts/ingest.ts`: the entry of `npm run ingest`. Reads the arguments (`parseCommandLine`), checks the credentials, selects the model transport (`selectTransport`, kind `Eval`), connects an MCP client to `MCP_URL` of `scripts/deploy.ts` and calls `ingestFiles`.
- `scripts/lib/ingest.ts`: `ingestFiles` (the loop over the files and their parts, the output lines and the exit code), `extract` (the call for 1 part: `Transport.send` with `EXTRACTION_PROMPT`, the zod schema `extractionAnswer` read with `stripFence` of `src/updates/questions/call.ts`, the drops, the cost by `costUsd`; `ExtractionError` carries the cost of a failed answer), `readLines` (the text check), `splitParts` (the parts of at most `MAX_PART_BYTES`), `queueClaims` (one `requestChange` per claim; the reason of a refusal is `toolText`) and `assertWikiExists` (`listWikis`).
- `__tests__/requirements/ingest.test.ts`: the requirement tests, with a stub transport and a scratch management endpoint.
- `scripts/lib/__tests__/ingest.test.ts`: unit tests with a stub transport and a stub client: the wiki check, the refusal line, the cost of a failed call and the parts.
