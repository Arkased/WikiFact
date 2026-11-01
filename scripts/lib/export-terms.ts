// technical/publication.md#private-terms: the terms file, the scan and the pairs.
import { readFileSync } from "node:fs";
import { HTML_ENTITIES } from "./html-entities.js";
import { ScriptError } from "./shell.js";

/** A pair of the terms file: a term that history holds and a text that takes its place. */
export interface TermPair {
  term: string;
  replacement: string;
}

/** The terms of `publication/private-terms.txt`. */
export interface PrivateTerms {
  /** The terms that stop the export when they occur. */
  blocks: string[];
  /** The terms that the export replaces; a pair term that survives the replacement stops the export too. */
  pairs: TermPair[];
}

/** One place where a term occurs. */
export interface TermHit {
  /** `<file>:<line>` or `<table>.<column> rowid <n>`. */
  where: string;
  term: string;
}

/** The mark between a term and its replacement in the terms file. */
const PAIR_MARK = " => ";

/**
 * Parses the terms file: 1 term per line, `#` starts a comment line, `<term> => <replacement>` is a pair.
 *
 * @param text - the content of the terms file
 * @returns the block terms and the pairs
 * @throws {ScriptError} when a term has no letter or digit, because its compact form would be empty and match every text
 * @sideEffects none
 */
export function parseTerms(text: string): PrivateTerms {
  const terms: PrivateTerms = { blocks: [], pairs: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf(PAIR_MARK);
    const term = (at < 0 ? line : line.slice(0, at)).trim();
    if (!/[\p{L}\p{N}]/u.test(term)) throw new ScriptError(`a private term needs a letter or a digit: "${term}"`);
    if (at < 0) terms.blocks.push(term);
    else terms.pairs.push({ term, replacement: line.slice(at + PAIR_MARK.length).trim() });
  }
  return terms;
}

/**
 * Reads the terms file.
 *
 * @param path - the path of `publication/private-terms.txt`
 * @returns the terms, from `parseTerms`
 * @throws {ScriptError} when the file is missing or holds no term, so that a missing file never passes the scan, or
 *   when `parseTerms` refuses a term
 * @sideEffects reads the file
 */
export function loadTerms(path: string): PrivateTerms {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ScriptError(`the terms file ${path} is missing: the export cannot scan without it`);
  }
  const terms = parseTerms(text);
  if (terms.blocks.length + terms.pairs.length === 0) throw new ScriptError(`the terms file ${path} holds no term`);
  return terms;
}

/** A character that the compact form keeps. */
const KEPT_CHAR = /[\p{L}\p{N}]/u;
/** A character that the compact form drops. */
const DROPPED_CHARS = /[^\p{L}\p{N}]/gu;
/** A run of `%XX` escapes. */
const ESCAPE_RUN = /(?:%[0-9a-f]{2})+/gi;
/** The length of one escape in a run: `%` and 2 hex digits. */
const ESCAPE_LENGTH = 3;
/** The radix of the digits of an escape. */
const HEX_RADIX = 16;
/** The most bytes that one UTF-8 character holds. */
const UTF8_MAX_BYTES = 4;
/** The most rounds of the full decode, so a text encoded 3 times is read and a loop cannot run on. */
const MAX_DECODE_ROUNDS = 3;
/** The strict decoder for the bytes of an escape run. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The compact form: NFC, lower case, and only letters and digits. NFC first, so a combining mark that follows a letter
// is part of it; a lone mark is dropped with the other non-letters.
function compact(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(DROPPED_CHARS, "");
}

// Decodes a run of escapes. A valid UTF-8 sequence gives its characters, any other byte its latin1 character. With
// `onlySeparators`, an escape whose character is a letter or a digit stays as written.
function decodeRun(run: string, onlySeparators: boolean): string {
  const bytes: number[] = [];
  for (let i = 0; i < run.length; i += ESCAPE_LENGTH) {
    bytes.push(Number.parseInt(run.slice(i + 1, i + ESCAPE_LENGTH), HEX_RADIX));
  }
  let out = "";
  for (let i = 0; i < bytes.length;) {
    let char = String.fromCharCode(bytes[i] ?? 0);
    let length = 1;
    for (let n = 1; n <= UTF8_MAX_BYTES && i + n <= bytes.length; n++) {
      try {
        char = UTF8.decode(Uint8Array.from(bytes.slice(i, i + n)));
        length = n;
        break;
      } catch {
        // Not a whole sequence yet: try 1 more byte, and the latin1 character if none fits.
      }
    }
    out += onlySeparators && KEPT_CHAR.test(char) ? run.slice(i * ESCAPE_LENGTH, (i + length) * ESCAPE_LENGTH) : char;
    i += length;
  }
  return out;
}

// The folded compact form: NFKD, the marks removed, lower case, and only letters and digits. So `é` is `e` and a
// full-width letter is its plain letter.
function compactFold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(DROPPED_CHARS, "");
}

// One round of the full decode: every escape run decoded.
function decodeRound(text: string): string {
  return text.replace(ESCAPE_RUN, (run) => decodeRun(run, false));
}

/** A JSON `\uXXXX` escape, a numeric HTML entity (`;` optional, leading zeros allowed) or a named one. */
const TEXT_ESCAPE = /\\u([0-9a-f]{4})|&#0*(\d{1,7});?|&#x0*([0-9a-f]{1,6});?|&([a-z][a-z0-9]*);/gi;
/** The last code point. */
const MAX_CODE_POINT = 0x10ffff;
/** The radix of a decimal entity. */
const DECIMAL_RADIX = 10;
/** The first byte above ASCII. */
const FIRST_NON_ASCII = 0x80;
/** An escape `%XX`, with its 2 digits. */
const ESCAPE = /%([0-9a-f]{2})/gi;
/** A character that is an ASCII letter or digit. */
const ASCII_ALNUM = /[A-Za-z0-9]/;

// One round of the JSON and HTML unescape.
function unescapeRound(text: string): string {
  return text.replace(TEXT_ESCAPE, (...args: unknown[]) => {
    const all = String(args[0]);
    const [json, dec, hex, name] = args.slice(1, 5) as (string | undefined)[];
    if (name !== undefined) return HTML_ENTITIES.get(name) ?? all;
    let code: number;
    if (json !== undefined) code = Number.parseInt(json, HEX_RADIX);
    else if (dec !== undefined) code = Number.parseInt(dec, DECIMAL_RADIX);
    else code = Number.parseInt(hex ?? "", HEX_RADIX);
    return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : all;
  });
}

// The texts of the rounds of a repeated change, MAX_DECODE_ROUNDS of them; a round that changes nothing repeats the
// last text, so each chain has the same number of views.
function rounds(line: string, step: (text: string) => string): string[] {
  const out: string[] = [];
  let text = line;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    text = step(text);
    out.push(text);
  }
  return out;
}

// Only the escapes of characters that are not letters or digits, decoded once.
function decodeSeparators(line: string): string {
  return line.replace(ESCAPE_RUN, (run) => decodeRun(run, true));
}

// Each escape whose byte is a separator below 0x80 removed, the rest kept as written. So `50%ACME%20Corp`, a literal `%`
// and an encoded space, loses the space and keeps `%AC`.
function dropAsciiSeparatorEscapes(line: string): string {
  return line.replace(ESCAPE, (all: string, hex: string) => {
    const byte = Number.parseInt(hex, HEX_RADIX);
    return ASCII_ALNUM.test(String.fromCharCode(byte)) || byte >= FIRST_NON_ASCII ? all : "";
  });
}

// The views of 1 line: the text, each round of the full decode, the separator views, each round of the JSON and HTML
// unescape, and each round of both together.
function readsOf(line: string): string[] {
  return [
    line,
    ...rounds(line, decodeRound),
    decodeSeparators(line),
    dropAsciiSeparatorEscapes(line),
    ...rounds(line, unescapeRound),
    ...rounds(line, (t) => unescapeRound(decodeRound(t))),
  ];
}

/** The compact forms of 1 view of a text, as they are and folded, and where each line starts in them. */
interface View {
  form: string;
  fold: string;
  lineStarts: number[];
  foldStarts: number[];
}

// The views of a text. Each view is built line by line, so a match maps back to the original line without a map of
// positions; the lines join in the form, so a term that a line break splits is found.
function viewsOf(text: string): View[] {
  const views: View[] = [];
  for (const line of text.split("\n")) {
    readsOf(line).forEach((read, i) => {
      const view = (views[i] ??= { form: "", fold: "", lineStarts: [], foldStarts: [] });
      view.lineStarts.push(view.form.length);
      view.foldStarts.push(view.fold.length);
      view.form += compact(read);
      view.fold += compactFold(read);
    });
  }
  return views;
}

// The 1-based line of the original text for an index of a form: the last line that starts at or before it.
function lineOf(starts: number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Finds the terms in a text. A term matches when its compact form (NFC, lower case, only letters and digits) occurs in
 * the compact form of at least 1 view of the text, or its folded form (NFKD, marks removed, then the same) occurs in
 * the folded form of the view. The views: the text as it is; each of 3 rounds of the full percent-decode (latin1 for a
 * byte that is not UTF-8); only the escapes of non-alphanumeric characters decoded; the escapes of non-alphanumeric
 * ASCII bytes removed; each of 3 rounds of the JSON `\uXXXX` and HTML entity decode; and each
 * of 3 rounds of both decodes together. A line break is dropped with the other separators, so a term that it splits is
 * found.
 *
 * @param text - the text to scan
 * @param terms - the terms to look for, of both kinds
 * @returns for each term and each line where a match starts, the 1-based line number of the original text and the term,
 *   by line; empty when nothing matches
 * @sideEffects none
 */
export function findTerms(text: string, terms: string[]): { line: number; term: string }[] {
  const views = viewsOf(text);
  const hits: { line: number; term: string }[] = [];
  for (const term of terms) {
    const needle = compact(term);
    const foldNeedle = compactFold(term);
    const lines = new Set<number>();
    for (const view of views) {
      for (let at = view.form.indexOf(needle); at >= 0; at = view.form.indexOf(needle, at + 1)) {
        lines.add(lineOf(view.lineStarts, at));
      }
      for (let at = view.fold.indexOf(foldNeedle); at >= 0; at = view.fold.indexOf(foldNeedle, at + 1)) {
        lines.add(lineOf(view.foldStarts, at));
      }
    }
    for (const line of lines) hits.push({ line, term });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Lists every term, of both kinds, that the scan looks for.
 *
 * @param terms - the parsed terms file
 * @returns the block terms, then the terms of the pairs
 * @sideEffects none
 */
export function scanTerms(terms: PrivateTerms): string[] {
  return [...terms.blocks, ...terms.pairs.map((p) => p.term)];
}

/** The change from a text to one spelling of it. */
type Spelling = (text: string) => string;

// The 5 spellings of the table (the URL one in 2 forms, with and without `%2F` as `/`), the plain one first.
const FOLDER_SPELLING: Spelling = (s) => s.replace(/[^A-Za-z0-9]/g, "-");
const SPELLINGS: Spelling[] = [
  (s) => s,
  (s) => s.replaceAll("\\", "/"),
  (s) => s.replaceAll("\\", "\\\\"),
  FOLDER_SPELLING,
  (s) => encodeURIComponent(s),
  (s) => encodeURIComponent(s).replaceAll("%2F", "/"),
];

// A text as a regular expression that matches it literally.
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Replaces each pair in its 5 spellings (plain, forward, JSON, folder name, URL), case-insensitively, each by the same
 * spelling of the replacement. The longest spelling goes first, and one pass reads the text, so a replacement is never
 * read again. A spelling outside the 5 stays in the text, and the scan then finds it.
 *
 * @param text - the text to rewrite
 * @param pairs - the pairs of the terms file
 * @returns the text with each match replaced
 * @sideEffects none
 */
export function applyPairs(text: string, pairs: TermPair[]): string {
  const entries: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const { term, replacement } of pairs) {
    for (const spell of SPELLINGS) {
      const from = spell(term);
      // A folder name without an ASCII letter or digit is only dashes: it would replace every separator.
      if (spell === FOLDER_SPELLING && !ASCII_ALNUM.test(from)) continue;
      if (seen.has(from.toLowerCase())) continue;
      seen.add(from.toLowerCase());
      entries.push({ from, to: spell(replacement) });
    }
  }
  if (entries.length === 0) return text;
  entries.sort((a, b) => b.from.length - a.from.length);
  const found = new RegExp(entries.map((e) => `(${literal(e.from)})`).join("|"), "giu");
  return text.replace(found, (...args: unknown[]) => {
    const index = args.findIndex((arg, i) => i > 0 && typeof arg === "string");
    return entries[index - 1]?.to ?? String(args[0]);
  });
}
