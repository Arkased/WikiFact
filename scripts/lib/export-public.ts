// technical/publication.md: the export of the build branch into a clone of the public repo.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { z } from "zod";
import { JSON_INDENT } from "../../src/constants.js";
import { buildDemoCopy, DEMO_DIR } from "./export-demo.js";
import { commitAll, commitIdentities, requireSource, requireTarget, trackedFiles } from "./export-git.js";
import { rewriteLinks } from "./export-links.js";
import { resultFilesToDrop } from "./export-results.js";
import { isExcluded, loadExportRules, type ExportRules } from "./export-rules.js";
import { applyPairs, findTerms, loadTerms, scanTerms, type PrivateTerms, type TermHit } from "./export-terms.js";
import { ScriptError } from "./shell.js";

/** The rules file, relative to the root. The public tree holds it at the same path. */
const RULES_FILE = "publication/export.json";
/** The terms file, relative to the root; git ignores it. */
const TERMS_FILE = "publication/private-terms.txt";
/** The public README, relative to the root. It is written as `README.md`. */
const README_SOURCE = "publication/README.md";
const DEMO_DB = `${DEMO_DIR}/game.sqlite`;
const DEMO_CONFIG = `${DEMO_DIR}/wikifact.json`;
const GITIGNORE = ".gitignore";
/** The ignore line for the folder where `npm run demo` puts the copy that the service writes to. */
const SERVED_COPIES_IGNORE = "wikis/";
/** The start of a path in the rules file that means the home folder of the user. */
const HOME_PREFIX = "~/";
/** The folder of the temp folder where the public tree is built before the target is touched. */
const TREE_DIR = "tree";

/** The public tree: a text file is a string, any other file is bytes. */
type Tree = Map<string, string | Buffer>;

const packageSchema = z.looseObject({ version: z.string() });

/** The private terms that stopped the export. The message lists each place. */
export class PrivateTermsFound extends ScriptError {
  /** Each place where a term occurs. */
  readonly hits: TermHit[];

  /**
   * Builds the error.
   *
   * @param hits - the places; not empty
   * @sideEffects none
   */
  constructor(hits: TermHit[]) {
    super(
      `private terms found, the export stopped before the commit:\n${hits.map((h) => `${h.where}: ${h.term}`).join("\n")}`,
    );
    this.name = "PrivateTermsFound";
    this.hits = hits;
  }
}

/** What an export did. */
export interface ExportOutcome {
  /** The version in the commit message. */
  version: string;
  /** False when the public tree equals the last commit of the target. */
  committed: boolean;
}

// The bytes as text, or undefined when they are not valid UTF-8 or the text holds U+0000. A UTF-16LE file of ASCII text
// is valid UTF-8, and its NUL bytes hide each term from the scan, so it counts as binary.
function decodeText(decoder: TextDecoder, bytes: Buffer): string | undefined {
  try {
    const text = decoder.decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Reads the tracked files that the export keeps, the public README as `README.md`, and the rules file.
 *
 * @param root - the source repo
 * @param rules - the rules of the export
 * @returns the tree: a file that is valid UTF-8 and holds no U+0000 is a string, with the BOM kept; a file on the list
 *   `binaryAllow` that is not such text is bytes
 * @throws {ScriptError} when the public README is missing, or a file is not such text and its path matches no
 *   pattern of `binaryAllow`
 * @sideEffects runs git; reads the files
 */
async function readTree(root: string, rules: ExportRules): Promise<Tree> {
  const readme = join(root, README_SOURCE);
  if (!existsSync(readme)) throw new ScriptError(`${README_SOURCE} is missing`);
  const paths = (await trackedFiles(root)).filter((p) => !isExcluded(p, rules));
  const sources: [string, string][] = [
    ...paths.map((p): [string, string] => [p, join(root, p)]),
    ["README.md", readme],
    [RULES_FILE, join(root, RULES_FILE)],
  ];
  const tree: Tree = new Map();
  const refused: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const [path, file] of sources) {
    const bytes = readFileSync(file);
    const text = decodeText(decoder, bytes);
    if (text !== undefined) tree.set(path, text);
    else if (rules.binaryAllow.some((pattern) => posix.matchesGlob(path, pattern))) tree.set(path, bytes);
    else refused.push(path);
  }
  if (refused.length > 0) {
    throw new ScriptError(
      `a file is not valid UTF-8 and is not on the list binaryAllow of ${RULES_FILE}: ${refused.join(", ")}`,
    );
  }
  return tree;
}

/**
 * Rewrites the links of the exported markdown files to excluded paths, and removes the `private` field of
 * `package.json`.
 *
 * @param tree - the tree; changed in place
 * @param rules - the rules of the export
 * @returns the version of the package
 * @throws {ScriptError} when `package.json` is not in the tree
 * @throws {Error} when `package.json` is not JSON; a `ZodError` when it has no string `version`
 * @sideEffects changes `tree`
 */
function shapeTree(tree: Tree, rules: ExportRules): string {
  for (const [path, content] of tree) {
    if (typeof content === "string" && path.endsWith(".md")) {
      tree.set(
        path,
        rewriteLinks(path, content, (p) => isExcluded(p, rules)),
      );
    }
  }
  const text = tree.get("package.json");
  if (typeof text !== "string") throw new ScriptError("package.json is missing from the tree");
  const pkg = packageSchema.parse(JSON.parse(text));
  const rest = Object.fromEntries(Object.entries(pkg).filter(([key]) => key !== "private"));
  tree.set("package.json", `${JSON.stringify(rest, null, JSON_INDENT)}\n`);
  return pkg.version;
}

/**
 * Applies the pairs to the text files of the tree.
 *
 * @param tree - the tree; its text changes in place
 * @param terms - the private terms
 * @sideEffects changes `tree`
 */
function applyPairsToTree(tree: Tree, terms: PrivateTerms): void {
  for (const [path, content] of tree) {
    if (typeof content === "string") tree.set(path, applyPairs(content, terms.pairs));
  }
}

/**
 * Leaves out the result files that no rule keeps. The texts that name result files are read as they are written to the
 * public repo: after the links and the pairs.
 *
 * @param tree - the tree; changed in place
 * @param rules - the rules of the export
 * @sideEffects changes `tree`
 */
function dropResultFiles(tree: Tree, rules: ExportRules): void {
  const isResult = (path: string): boolean => rules.resultFolders.some((f) => path.startsWith(`${f}/`));
  const texts = [...tree].flatMap(([path, content]) =>
    typeof content === "string" && !isResult(path) ? [content] : [],
  );
  for (const path of resultFilesToDrop([...tree.keys()], rules.resultFolders, texts)) tree.delete(path);
}

/**
 * Scans the tree for the terms: each path, each text, and each binary file decoded as latin1 and as UTF-16LE (at both
 * byte offsets, because a 16-bit unit can start at either).
 *
 * @param tree - the tree after the pairs
 * @param terms - the private terms
 * @returns the places where a term occurs
 * @sideEffects none
 */
function scanTree(tree: Tree, terms: PrivateTerms): TermHit[] {
  const needles = scanTerms(terms);
  const hits: TermHit[] = [];
  for (const [path, content] of tree) {
    hits.push(...findTerms(path, needles).map((h) => ({ where: `${path} (path)`, term: h.term })));
    if (typeof content === "string") {
      hits.push(...findTerms(content, needles).map((h) => ({ where: `${path}:${h.line}`, term: h.term })));
      continue;
    }
    const decodings: [string, string][] = [
      ["latin1", content.toString("latin1")],
      ["utf16le", content.toString("utf16le")],
      ["utf16le, odd offset", content.subarray(1).toString("utf16le")],
    ];
    for (const [encoding, text] of decodings) {
      hits.push(...findTerms(text, needles).map((h) => ({ where: `${path} (as ${encoding})`, term: h.term })));
    }
  }
  return hits;
}

/**
 * Expands a leading `~/` to the home folder.
 *
 * @param path - a path from the rules file
 * @returns the path
 * @sideEffects reads the home folder of the user
 */
function expandHome(path: string): string {
  return path.startsWith(HOME_PREFIX) ? join(homedir(), path.slice(HOME_PREFIX.length)) : path;
}

/**
 * Writes the tree and the demo store to a folder.
 *
 * @param dir - an empty folder
 * @param tree - the public tree
 * @param demoDb - the demo store to copy to `demo/wikifact/game.sqlite`
 * @sideEffects creates folders and files in `dir`
 */
function writeTree(dir: string, tree: Tree, demoDb: string): void {
  for (const [path, content] of tree) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  mkdirSync(join(dir, DEMO_DIR), { recursive: true });
  copyFileSync(demoDb, join(dir, DEMO_DB));
}

/**
 * Exports the tracked files of the source repo into the target repo and commits them there.
 *
 * @param root - the source repo, on the branch `build` with a clean tree
 * @param target - a local clone of the public repo with no uncommitted change
 * @returns what the export did
 * @throws {ScriptError} when the source or the target is refused, the terms file is missing or empty, a file is
 *   missing, or a file is not valid UTF-8 and not on `binaryAllow`
 * @throws {PrivateTermsFound} when a private term occurs in a path, in a copied file, in the demo copy or in the
 *   identity of the commit in the target; the target is not touched
 * @sideEffects runs git in both repos; reads the home folder; makes a temp folder for the demo copy and the public tree
 *   and deletes it; deletes every file of the target except `.git`, copies the public tree there and commits; never
 *   pushes
 */
export async function exportPublic(root: string, target: string): Promise<ExportOutcome> {
  await requireSource(root);
  await requireTarget(target, root);
  const rules = loadExportRules(join(root, RULES_FILE));
  const terms = loadTerms(join(root, TERMS_FILE));
  const tree = await readTree(root, rules);
  const version = shapeTree(tree, rules);

  const work = mkdtempSync(join(tmpdir(), "wikifact-export-"));
  try {
    const demo = await buildDemoCopy(expandHome(rules.demo.source), work, terms);
    const config = { ...rules.demo.config, subject: demo.subject, embeddingModel: demo.embeddingModel };
    tree.set(DEMO_CONFIG, `${JSON.stringify(config, null, JSON_INDENT)}\n`);
    const ignore = String(tree.get(GITIGNORE) ?? "");
    tree.set(GITIGNORE, `${ignore}${ignore === "" || ignore.endsWith("\n") ? "" : "\n"}${SERVED_COPIES_IGNORE}\n`);
    applyPairsToTree(tree, terms);
    dropResultFiles(tree, rules);

    const built = join(work, TREE_DIR);
    writeTree(built, tree, demo.dbPath);

    const needles = scanTerms(terms);
    const hits = scanTree(tree, terms);
    for (const { name, value } of await commitIdentities(target)) {
      hits.push(...findTerms(value, needles).map((h) => ({ where: `git var ${name}`, term: h.term })));
    }
    hits.push(...demo.hits);
    if (hits.length > 0) throw new PrivateTermsFound(hits);

    for (const name of readdirSync(target)) if (name !== ".git") rmSync(join(target, name), { recursive: true });
    cpSync(built, target, { recursive: true });
    return { version, committed: await commitAll(target, `WikiFact v${version}`) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
