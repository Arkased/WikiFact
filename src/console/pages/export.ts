// technical/console.md, "Routes": the export of every fact as a file, not a page. `?format=json|md&deleted=0|1`. JSON holds
// every fact with its current version and its confidence; Markdown lists the facts by header, one line per fact. A fact-check artifact to read in an editor or hand to a reviewer.
import { z } from "zod";
import { ExportFormat, assertNever } from "../../domain/enums.js";
import { exportFacts, type FactListItem } from "../../store/index.js";
import type { FileAnswer, PageContext } from "../page.js";
import { flag, parseQuery, withWikiStore } from "./parts/index.js";
import { JSON_INDENT, DISPLAY_DECIMALS } from "../../constants.js";

const exportQuery = z.object({
  format: z.enum(ExportFormat).default(ExportFormat.Json),
  deleted: flag,
});

/**
 * Renders the facts as JSON.
 *
 * @param wiki - the wiki name
 * @param now - the export time, in ms since the epoch
 * @param facts - the facts
 * @returns the JSON text, indented
 * @sideEffects none
 */
function factsJson(wiki: string, now: number, facts: FactListItem[]): string {
  return JSON.stringify(
    {
      wiki,
      exportedAt: new Date(now).toISOString(),
      facts: facts.map((f) => ({
        id: f.id,
        header: f.header,
        content: f.content,
        confidence: f.confidence,
        usefulness: f.usefulness,
        isDeleted: f.isDeleted,
        versions: f.versions,
        seq: f.lastChangedSeq,
        created: new Date(f.created).toISOString(),
      })),
    },
    null,
    JSON_INDENT,
  );
}

/**
 * Renders the facts as Markdown, one line per fact, sorted by header A to Z.
 *
 * @param wiki - the wiki name
 * @param facts - the facts
 * @returns the Markdown text
 * @sideEffects none
 */
function factsMarkdown(wiki: string, facts: FactListItem[]): string {
  const line = (f: FactListItem): string => {
    const state = f.isDeleted ? ", deleted" : "";
    return `- **${f.header}** — ${f.content} (confidence ${f.confidence.toFixed(DISPLAY_DECIMALS)}${state})`;
  };
  const sorted = [...facts].sort((a, b) => a.header.localeCompare(b.header, "en", { sensitivity: "base" }));
  return `# ${wiki}: facts\n\n${sorted.map(line).join("\n")}\n`;
}

/**
 * Answers `GET /console/w/:w/facts/export?format=json|md&deleted=0|1` with a file.
 *
 * @param ctx - the deps, the wiki in `params.w`, and the format and the deleted flag in the query
 * @returns the file: `<wiki>-facts.json` or `<wiki>-facts.md`
 * @throws {ConsoleError} `NotFound` for an unknown wiki; `ZodError` for a bad query
 * @sideEffects opens and closes one read-only store; reads the clock once; one unpaged read of every fact
 */
export async function exportPage(ctx: PageContext): Promise<FileAnswer> {
  const q = parseQuery(ctx.query, exportQuery);
  return withWikiStore(ctx, ({ wiki, store, now }) => {
    const facts = exportFacts(store, now, q.deleted);
    switch (q.format) {
      case ExportFormat.Json:
        return {
          body: factsJson(wiki.name, now, facts),
          contentType: "application/json; charset=utf-8",
          fileName: `${wiki.name}-facts.json`,
        };
      case ExportFormat.Md:
        return {
          body: factsMarkdown(wiki.name, facts),
          contentType: "text/markdown; charset=utf-8",
          fileName: `${wiki.name}-facts.md`,
        };
    }
    return assertNever(q.format);
  });
}
