// technical/ingest.md, "Extraction call", "Queue" and "Output": the core of `npm run ingest`. The entry file
// `scripts/ingest.ts` connects it to the model transport and to the service.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { costUsd, type PriceTable } from "../../src/config/index.js";
import { COST_DECIMALS } from "../../src/constants.js";
import { Effort, McpToolName, MessageRole, QuestionKind, StopReason } from "../../src/domain/enums.js";
import { errorMessage } from "../../src/must.js";
import { MS_PER_SECOND } from "../../src/time.js";
import { jsonSchemaOf, LONG_MAX_TOKENS, modelFeatures, type Transport } from "../../src/updates/index.js";
import { stripFence } from "../../src/updates/questions/call.js";

/** The model of the extraction call: Sonnet 5.5, as the `standard` preset names it (design/ingest.md). */
export const EXTRACTION_MODEL = "claude-sonnet-5-5";
/** The effort of the extraction call. */
const EXTRACTION_EFFORT = Effort.Low;
/** The largest part of a file that one call takes, in bytes of UTF-8 (technical/ingest.md, "Extraction call"). */
export const MAX_PART_BYTES = 20_000;
/** The wall-clock limit of one extraction call, in seconds. */
const EXTRACTION_TIMEOUT_S = 600;

/**
 * The extraction prompt of the study of 2026-10-27 (docs/research/document-ingestion-2026-10-27.md, "The extraction
 * prompt"), word for word.
 */
const EXTRACTION_PROMPT = `You read one file of a repository and extract its claims for a fact wiki about that repository. The wiki answers the questions that a developer asks about the repository, so that the developer does not open the file.

A claim is one statement that the file makes about the repository and that a reader can check against the file.

Rules:
1. One claim states one attribute: one value, one rule, one name, one order, one limit or one cause. If a sentence holds two attributes (a value and its reason, two limits, two steps), write two claims.
2. A claim stands alone. Name its subject in full (the file, function, command, table or setting). Use no pronoun, and no words such as "above", "this file" or "the section". Keep the exact names, numbers and units of the file.
3. State only what the file states. Add no inference, no advice and no fact from your own knowledge.
4. Skip headings, links, navigation text, examples that only repeat a rule, and text that says nothing checkable.
5. For each claim, give "line": the number of the first line of the file that states it. The file text starts each line with its number and a tab.
6. Return every claim of the file, in file order.

Return the claims as JSON that matches the schema.`;

/** The answer of the extraction call: the claims of one file, each with the line that states it. */
const extractionAnswer = z.object({
  claims: z.array(z.object({ claim: z.string(), line: z.number() })),
});

/** What `ingestFiles` needs. */
export interface IngestOptions {
  /** The wiki that receives the claims. */
  wiki: string;
  /** The files as the operator typed them. */
  files: string[];
  /** The folder where the command runs; the justification names each file relative to it. */
  cwd: string;
  /** The model transport of the service. */
  transport: Transport;
  /** The price table, for the cost of each call. */
  prices: PriceTable;
  /** A connected client of the management endpoint `/mcp`. */
  client: Pick<Client, "callTool">;
  /** Receives each output line. */
  print: (line: string) => void;
}

/** What `ingestFiles` reports. */
export interface IngestReport {
  /** 0 when every file was read and every claim was queued, else 1. */
  exitCode: number;
  /** The claims queued over all files. */
  queued: number;
  /** The model cost of all calls, in USD. */
  costUsd: number;
}

/** The result of the extraction of one file. */
interface Extracted {
  claims: { claim: string; line: number }[];
  dropped: number;
  costUsd: number;
}

/** A failure of an extraction call after the model answered: it still carries the cost of the call. */
class ExtractionError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
  }
}

/** One part of a file: whole lines, and the number of the first one in the file. */
export interface Part {
  /** The number of the first line of the part, counted from 1 in the whole file. */
  firstLine: number;
  lines: string[];
}

/**
 * Makes the user message of a part: the file name, then each line as `N<TAB>text`, numbered in the whole file.
 *
 * @param path - the path as the justification names it
 * @param part - the part
 * @returns the message text
 * @sideEffects none
 */
function renderPart(path: string, part: Part): string {
  return [`File: ${path}`, ...part.lines.map((text, i) => `${part.firstLine + i}\t${text}`)].join("\n");
}

/**
 * Splits the lines of a file into parts of at most `MAX_PART_BYTES` bytes of UTF-8 (the lines and their line breaks).
 * A part ends at a line break; a line longer than the limit is a part of its own.
 *
 * @param lines - the lines of the file
 * @returns the parts in file order; none for a file with no lines
 * @sideEffects none
 */
export function splitParts(lines: string[]): Part[] {
  const parts: Part[] = [];
  let current: Part | undefined;
  let bytes = 0;
  lines.forEach((text, i) => {
    const size = Buffer.byteLength(text, "utf8") + 1;
    if (current === undefined || bytes + size > MAX_PART_BYTES) {
      current = { firstLine: i + 1, lines: [] };
      parts.push(current);
      bytes = 0;
    }
    current.lines.push(text);
    bytes += size;
  });
  return parts;
}

/**
 * Reads a file as UTF-8 text and splits it into lines.
 *
 * @param absolute - the absolute path
 * @returns the lines; a final line break ends the last line and starts no new one
 * @throws {Error} when the file does not exist or is not UTF-8
 * @sideEffects reads the file
 */
function readLines(absolute: string): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Asks the model for the claims of one part of a file and drops the claims that have no text or a line outside the part.
 *
 * @param opts - the transport and the prices
 * @param path - the path of the file as the justification names it
 * @param part - the part to read
 * @returns the kept claims in the order of their lines, the dropped count and the cost of the call
 * @throws {ExtractionError} when the answer hits the token limit or does not match the schema (it carries the cost)
 * @throws {Error} when the call itself fails
 * @sideEffects one model call
 */
async function extract(opts: IngestOptions, path: string, part: Part): Promise<Extracted> {
  const features = modelFeatures(EXTRACTION_MODEL);
  const res = await opts.transport.send(
    {
      model: EXTRACTION_MODEL,
      kind: QuestionKind.Drafting,
      effort: EXTRACTION_EFFORT,
      system: EXTRACTION_PROMPT,
      messages: [{ role: MessageRole.User, content: renderPart(path, part) }],
      schema: jsonSchemaOf(extractionAnswer),
      maxTokens: LONG_MAX_TOKENS,
      stream: true,
      thinking: features.thinking,
      fallback: features.fallback,
    },
    AbortSignal.timeout(EXTRACTION_TIMEOUT_S * MS_PER_SECOND),
  );
  const cost = costUsd(opts.prices, EXTRACTION_MODEL, {
    input: res.usage.input,
    cacheWrite: res.usage.cacheWrite,
    cacheRead: res.usage.cacheRead,
    output: res.usage.output,
  });
  if (res.stopReason === StopReason.MaxTokens) throw new ExtractionError("the answer hit the token limit", cost);
  let answer: z.infer<typeof extractionAnswer>;
  try {
    answer = extractionAnswer.parse(JSON.parse(stripFence(res.text)));
  } catch (e) {
    throw new ExtractionError(errorMessage(e), cost);
  }
  const last = part.firstLine + part.lines.length - 1;
  const kept = answer.claims.filter(
    (c) => c.claim.trim() !== "" && Number.isInteger(c.line) && c.line >= part.firstLine && c.line <= last,
  );
  return {
    claims: kept.map((c) => ({ claim: c.claim.trim(), line: c.line })).sort((a, b) => a.line - b.line),
    dropped: answer.claims.length - kept.length,
    costUsd: cost,
  };
}

/** The content blocks of a `callTool` result: only the type and the text are read. */
const toolContent = z.object({
  content: z.array(z.object({ type: z.string().optional(), text: z.string().optional() })),
});

/**
 * Takes the text of a tool result.
 *
 * @param res - the result of `callTool`
 * @returns the text blocks joined by a space, or a fixed phrase when there is none
 * @sideEffects none
 */
function toolText(res: object): string {
  const parsed = toolContent.safeParse(res);
  const text = (parsed.success ? parsed.data.content : [])
    .flatMap((b) => (b.type === "text" && b.text !== undefined ? [b.text] : []))
    .join(" ");
  return text === "" ? "the tool refused the call" : text;
}

/**
 * Sends the claims of one file to the wiki with `requestChange`, one call each, in line order.
 *
 * @param opts - the client and the wiki
 * @param path - the path for the justification
 * @param claims - the claims in line order
 * @returns the counts of the claims queued and refused
 * @sideEffects one `requestChange` call per claim, each of which queues a request in the wiki; prints a line per refusal
 */
async function queueClaims(
  opts: IngestOptions,
  path: string,
  claims: Extracted["claims"],
): Promise<{ queued: number; failed: number }> {
  let queued = 0;
  let failed = 0;
  for (const c of claims) {
    try {
      const res = await opts.client.callTool({
        name: McpToolName.RequestChange,
        arguments: { wiki: opts.wiki, change: c.claim, justification: `Stated in ${path} at line ${c.line}.` },
      });
      if (res.isError === true) throw new Error(toolText(res));
      queued += 1;
    } catch (e) {
      failed += 1;
      opts.print(`${path}: line ${c.line}: not queued (${errorMessage(e)})`);
    }
  }
  return { queued, failed };
}

/**
 * Checks that the service holds the wiki.
 *
 * @param opts - the client and the wiki
 * @throws {Error} when `listWikis` does not name the wiki
 * @sideEffects one `listWikis` call
 */
async function assertWikiExists(opts: IngestOptions): Promise<void> {
  const res = await opts.client.callTool({ name: McpToolName.ListWikis, arguments: {} });
  const listed = z.object({ wikis: z.array(z.object({ name: z.string() })) }).parse(res.structuredContent);
  if (!listed.wikis.some((w) => w.name === opts.wiki)) {
    throw new Error(`the service holds no wiki named ${opts.wiki}`);
  }
}

/**
 * Extracts the claims of each file with 1 model call per part and queues each claim as one request. A file that fails gets
 * one error line, and the next file goes on.
 *
 * @param opts - the wiki, the files, the transport, the service client and the output
 * @returns the exit code, the claims queued and the cost
 * @throws {Error} when the service holds no wiki of that name (before any model call)
 * @sideEffects one `listWikis` call; reads each input file; per file one model call for each part and one
 * `requestChange` call per claim; prints lines
 */
export async function ingestFiles(opts: IngestOptions): Promise<IngestReport> {
  await assertWikiExists(opts);
  const total = { files: 0, queued: 0, dropped: 0, costUsd: 0 };
  let ok = true;
  for (const file of opts.files) {
    const absolute = resolve(opts.cwd, file);
    const shown = isAbsolute(file) ? relative(opts.cwd, absolute) : file;
    const path = shown.split(sep).join("/").replace(/^\.\//, "");
    const found: Extracted = { claims: [], dropped: 0, costUsd: 0 };
    try {
      for (const part of splitParts(readLines(absolute))) {
        try {
          const got = await extract(opts, path, part);
          found.claims.push(...got.claims);
          found.dropped += got.dropped;
          found.costUsd += got.costUsd;
        } catch (e) {
          if (e instanceof ExtractionError) found.costUsd += e.costUsd;
          throw e;
        }
      }
      const { queued, failed } = await queueClaims(opts, path, found.claims);
      const failedText = failed > 0 ? `, ${failed} failed` : "";
      opts.print(
        `${path}: ${queued} claims queued, ${found.dropped} dropped${failedText}, $${found.costUsd.toFixed(COST_DECIMALS)}`,
      );
      total.files += 1;
      total.queued += queued;
      total.dropped += found.dropped;
      total.costUsd += found.costUsd;
      if (failed > 0) ok = false;
    } catch (e) {
      ok = false;
      total.costUsd += found.costUsd;
      const costText = found.costUsd > 0 ? `, $${found.costUsd.toFixed(COST_DECIMALS)}` : "";
      opts.print(`${path}: error: ${errorMessage(e)}${costText}`);
    }
  }
  opts.print(
    `total: ${total.files} files, ${total.queued} claims queued, ${total.dropped} dropped, $${total.costUsd.toFixed(COST_DECIMALS)}`,
  );
  return { exitCode: ok ? 0 : 1, queued: total.queued, costUsd: total.costUsd };
}
