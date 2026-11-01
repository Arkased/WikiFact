// technical/lookup.md, "Server instructions" (design/lookup.md, "When to search"; design/submit.md, "When to submit"): the server instructions of MCP, and the trigger texts that the `search` tool shares.

/**
 * technical/lookup.md, "Server instructions" (design/lookup.md, "When to search"): Claude Code cuts the server instructions at this many characters, so the text of
 * the management endpoint stays within it.
 */
export const INSTRUCTIONS_CAP = 4096;

/** design/lookup.md, "When to search". The first sentence of the instructions and of the `search` tool text. */
export const SEARCH_TRIGGER =
  "Search the wiki on a subject with the `search` tool before you read files or other sources about that subject, because it is faster and cheaper.";

/**
 * design/submit.md, "When to submit"; design/lookup.md, "Correction duty". The one sentence of the duty: the last
 * sentence of the instructions and the last of the tool texts of `search` and `getFact`.
 */
export const CORRECTION_DUTY =
  "Before you finish your task, send what you observed that the wiki lacks or gets wrong with the `requestChange` tool: what you saw, and how you know.";

/**
 * design/submit.md, "When to submit": the `note` of a `search` result with hits and of a `getFact` result. A tool result
 * reaches every agent that calls, a subagent too, which gets no server instructions.
 */
export const RESULT_NOTE =
  "Before you finish: send what you observed that the wiki lacks or gets wrong with requestChange, one claim per request, with how you know.";

/** design/submit.md, "When to submit": the `note` of a `search` result with no hit. */
export const EMPTY_NOTE =
  "No fact matches. When you find the answer elsewhere, send it with requestChange so the next agent finds it here.";

/** The name of a wiki on a single-wiki server, which has no name of its own. */
export const DEFAULT_WIKI_NAME = "wikifact";

const ELLIPSIS = "…";

/** A wiki as the instructions name it. */
export interface InstructionWiki {
  name: string;
  subject: string;
}

function wikiLine(w: InstructionWiki): string {
  return w.subject === "" ? `- ${w.name}` : `- ${w.name}: ${w.subject}`;
}

/**
 * Writes the instructions of a wiki endpoint.
 *
 * @param wiki - the name and the subject of the wiki
 * @returns the name and subject of the wiki, then the search trigger and the correction duty; at most
 *   `INSTRUCTIONS_CAP` characters, with a long subject cut and ended by an ellipsis
 * @sideEffects none
 */
export function wikiInstructions(wiki: InstructionWiki): string {
  const build = (subject: string): string => {
    const about = subject === "" ? "" : ` Its subject: ${subject}`;
    return `This is the wiki "${wiki.name}".${about}\n${SEARCH_TRIGGER}\n${CORRECTION_DUTY}`;
  };
  const over = build(wiki.subject).length - INSTRUCTIONS_CAP;
  if (over <= 0) return build(wiki.subject);
  // A subject too long for the cap is shortened, so that the triggers always arrive whole.
  const keep = Math.max(0, wiki.subject.length - over - ELLIPSIS.length);
  return build(wiki.subject.slice(0, keep) + ELLIPSIS);
}

/** The newlines that join the head and the tail to the list of wikis, in characters. */
const HEAD_TAIL_NEWLINES = 2;

/**
 * Writes the instructions of the management endpoint. Names as many wikis as fit in `INSTRUCTIONS_CAP`, then says how
 * many more there are and points to `listWikis`.
 *
 * @param wikis - the mounted wikis, in the order to name them
 * @returns the text, at most `INSTRUCTIONS_CAP` characters
 * @sideEffects none
 */
export function managementInstructions(wikis: readonly InstructionWiki[]): string {
  const head =
    "This service holds these wikis, each with a name and a subject. The `wiki` argument of every tool is the name.";
  const tail = `${SEARCH_TRIGGER}\n${CORRECTION_DUTY}`;
  const more = (n: number): string => `${n} more ${n === 1 ? "wiki" : "wikis"}: the \`listWikis\` tool names them.`;
  const lines: string[] = [];
  let used = head.length + tail.length + HEAD_TAIL_NEWLINES;
  for (const w of wikis) {
    const line = wikiLine(w);
    const rest = wikis.length - lines.length - 1;
    // Keep room for the "more" line when wikis would be left out.
    const reserve = rest > 0 ? more(rest).length + 1 : 0;
    if (used + line.length + 1 + reserve > INSTRUCTIONS_CAP) break;
    lines.push(line);
    used += line.length + 1;
  }
  const left = wikis.length - lines.length;
  const list = left > 0 ? [...lines, more(left)] : lines;
  return [head, ...list, tail].join("\n");
}
