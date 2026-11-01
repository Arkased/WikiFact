// technical/publication.md, "Links": a link to a path that the export leaves out becomes plain text, and a decision
// link of a reference list is removed.
import { posix } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";

/** A link or an image of a markdown file, with its place in the source. */
interface LinkNode {
  readonly image: boolean;
  /** The offset of the first character of the link in the source. */
  readonly start: number;
  /** The offset after the last character of the link in the source. */
  readonly end: number;
  readonly url: string;
  /** The span of the label in the source (empty for an empty label). */
  readonly label: readonly [number, number];
}

/** The part of a node of the syntax tree that this module reads. */
interface TreeNode {
  type: string;
  url?: string;
  children?: TreeNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Parses a markdown file with a CommonMark parser and finds its link and image nodes. Text in a code span or a code
 * block is not a link for the parser.
 *
 * @param text - the content of a markdown file
 * @returns the link and image nodes in source order, a nested one after the one that holds it
 * @sideEffects none
 */
function findLinks(text: string): LinkNode[] {
  const found: LinkNode[] = [];
  const walk = (node: TreeNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const children = node.children ?? [];
    if ((node.type === "link" || node.type === "image") && start !== undefined && end !== undefined) {
      const first = children[0]?.position?.start.offset;
      const last = children.at(-1)?.position?.end.offset;
      const label = first === undefined || last === undefined ? ([start, start] as const) : ([first, last] as const);
      found.push({ image: node.type === "image", start, end, url: node.url ?? "", label });
    }
    children.forEach(walk);
  };
  walk(fromMarkdown(text));
  return found;
}

/** An issue id in a reference list. */
const ISSUE_ID = /^#\d+/;

/** The items of a reference list are split at these separators. */
const SEPARATORS = [", ", "; "];

/** One item of a reference list, with the separator after it (empty for the last item). */
interface ListItem {
  readonly start: number;
  readonly end: number;
  readonly link?: LinkNode;
  readonly sep: string;
}

/** A reference list found in a text. */
interface ReferenceList {
  /** The offset of `(`. */
  readonly open: number;
  /** The offset after `)`. */
  readonly close: number;
  readonly items: readonly ListItem[];
}

/**
 * Finds the reference lists: a parenthesis in the source text whose content, split at `, ` and `; `, has only items
 * that are the whole source span of a link node, or an issue id.
 *
 * @param text - the content of the file
 * @param links - the link nodes of the file
 * @returns the lists in source order
 * @sideEffects none
 */
function findLists(text: string, links: readonly LinkNode[]): ReferenceList[] {
  const lists: ReferenceList[] = [];
  const starts = new Map(links.map((l) => [l.start, l]));
  let skipTo = 0;
  for (let open = text.indexOf("("); open !== -1; open = text.indexOf("(", open + 1)) {
    if (open < skipTo) continue;
    const items: ListItem[] = [];
    let pos = open + 1;
    for (;;) {
      const link = starts.get(pos);
      const id = link ? undefined : ISSUE_ID.exec(text.slice(pos))?.[0];
      const end = link?.end ?? (id === undefined ? undefined : pos + id.length);
      if (end === undefined) break;
      const sep = SEPARATORS.find((s) => text.startsWith(s, end)) ?? "";
      items.push({ start: pos, end, ...(link ? { link } : {}), sep });
      pos = end + sep.length;
      if (sep === "") break;
    }
    const last = items.at(-1);
    if (last?.sep !== "" || text[last.end] !== ")") continue;
    lists.push({ open, close: last.end + 1, items });
    skipTo = last.end + 1;
  }
  return lists;
}

/** A decision record: `docs/decisions/<digits>-<name>.md`. */
const DECISION_PATH = /^docs\/decisions\/\d+-[^/]+\.md$/;

/** A target with a scheme (`https:`, `mailto:`) points outside the repo. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves the target of a link against the folder of its file.
 *
 * @param file - the path of the markdown file, relative to the root
 * @param target - the target as written in the link
 * @returns the path relative to the root, or undefined for an anchor, a URL or a path outside the root
 * @sideEffects none
 */
function resolveTarget(file: string, target: string): string | undefined {
  if (target === "" || target.startsWith("#") || SCHEME.test(target)) return undefined;
  let path = target.replace(/[#?].*$/, "");
  try {
    path = decodeURI(path);
  } catch {
    // A target with a bad escape stays as written; it names no excluded path.
  }
  const resolved = posix.normalize(posix.join(posix.dirname(file), path));
  return resolved.startsWith("..") || resolved === "." ? undefined : resolved;
}

function isDecisionTarget(file: string, target: string): boolean {
  const path = resolveTarget(file, target);
  return path !== undefined && DECISION_PATH.test(path);
}

/** A change of the source text between 2 offsets; `render` gives the new text, and `inner` renders a part inside. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly render: (inner: (from: number, to: number) => string) => string;
}

/**
 * Applies edits to the source text, from the end to the start, so that an offset is valid until its edit is applied.
 * An edit that lies inside another one is applied only when that one renders its range with `inner`.
 *
 * @param text - the content of the file
 * @param edits - the edits, in any order
 * @returns the text with the edits applied, byte for byte outside them
 * @sideEffects none
 */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const range = (from: number, to: number): string => {
    const top: Edit[] = [];
    const inside = edits.filter((e) => e.start >= from && e.end <= to);
    for (const e of inside.sort((a, b) => a.start - b.start || b.end - a.end)) {
      const previous = top.at(-1);
      if (previous === undefined || e.start >= previous.end) top.push(e);
    }
    let out = text.slice(from, to);
    for (const e of top.reverse()) {
      out = out.slice(0, e.start - from) + e.render(range) + out.slice(e.end - from);
    }
    return out;
  };
  return range(0, text.length);
}

/**
 * Removes each decision link of a reference list, and turns each other markdown link whose target is an excluded
 * path into its text.
 *
 * @param file - the path of the markdown file, relative to the root, with forward slashes
 * @param text - the content of the file
 * @param excluded - tells whether a path, relative to the root, is left out; a folder is asked with a trailing `/`
 * @returns the content without those links
 * @sideEffects none
 */
export function rewriteLinks(file: string, text: string, excluded: (path: string) => boolean): string {
  const isOut = (target: string): boolean => {
    const path = resolveTarget(file, target);
    return path !== undefined && (excluded(path) || excluded(`${path}/`));
  };
  const links = findLinks(text);
  const edits: Edit[] = links
    .filter((l) => isOut(l.url))
    .map((l) => ({
      start: l.start,
      end: l.end,
      render: (inner) => (l.image ? "" : inner(l.label[0], l.label[1])),
    }));
  for (const list of findLists(text, links)) {
    const isDecision = (item: ListItem): boolean => item.link !== undefined && isDecisionTarget(file, item.link.url);
    if (!list.items.some(isDecision)) continue;
    const kept = list.items.filter((item) => !isDecision(item));
    const space = kept.length === 0 && text[list.open - 1] === " " ? 1 : 0;
    edits.push({
      start: list.open - space,
      end: list.close,
      render: (inner) => {
        if (kept.length === 0) return "";
        // A removed item takes the separator after it; the last one takes the separator before it.
        const body = kept.map((item, i) => inner(item.start, item.end) + (i < kept.length - 1 ? item.sep : ""));
        return `(${body.join("")})`;
      },
    });
  }
  return applyEdits(text, edits);
}

/**
 * Finds the decision links that are not in a reference list.
 *
 * @param file - the path of the markdown file, relative to the root, with forward slashes
 * @param text - the content of the file
 * @returns the line number (from 1) of each such link; a link inside code is text and is not counted
 * @sideEffects none
 */
export function decisionLinksOutsideLists(file: string, text: string): number[] {
  const links = findLinks(text);
  const lists = findLists(text, links);
  return links
    .filter((l) => isDecisionTarget(file, l.url))
    .filter((l) => !lists.some((list) => l.start >= list.open && l.start < list.close))
    .map((l) => text.slice(0, l.start).split("\n").length);
}

/** A plain mention of a decision record: the word `decision` or `decisions`, a space and 4 digits, in any case. */
const DECISION_MENTION = /decisions? \d{4}/gi;

/**
 * Finds the spans of a markdown file in which a mention is not plain: a decision link (its text is the citation), a
 * code span and a code block. A link to another target and an image are not exempt.
 *
 * @param file - the path of the markdown file, relative to the root, with forward slashes
 * @param text - the content of a markdown file
 * @returns the spans `[start, end)` in the source
 * @sideEffects none
 */
function exemptSpans(file: string, text: string): [number, number][] {
  const spans: [number, number][] = [];
  const walk = (node: TreeNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const exempt =
      node.type === "inlineCode" ||
      node.type === "code" ||
      (node.type === "link" && isDecisionTarget(file, node.url ?? ""));
    if (exempt && start !== undefined && end !== undefined) {
      spans.push([start, end]);
    } else {
      node.children?.forEach(walk);
    }
  };
  walk(fromMarkdown(text));
  return spans;
}

/**
 * Finds the plain mentions of a decision record: the word `decision` or `decisions`, a space and 4 digits, in any case.
 * In a markdown file, a mention in a link, a code span or a code block does not count. In another file, every mention
 * counts.
 *
 * @param file - the path of the file, relative to the root, with forward slashes
 * @param text - the content of the file
 * @returns the line number (from 1) of each plain mention
 * @sideEffects none
 */
export function plainDecisionMentions(file: string, text: string): number[] {
  const spans = file.endsWith(".md") ? exemptSpans(file, text) : [];
  return [...text.matchAll(DECISION_MENTION)]
    .filter((m) => !spans.some(([start, end]) => m.index >= start && m.index < end))
    .map((m) => text.slice(0, m.index).split("\n").length);
}
