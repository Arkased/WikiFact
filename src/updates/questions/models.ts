// The models that the question transports know: id, CLI alias, effort support and the fallback rule.
// Plain data. Nothing registers into it at run time, so `src` behaves the same whether or not an eval module was imported.
// The eval keeps its own data (prices, candidates, bars) in eval/questions/models.json.

/** What a transport must know about a model. */
interface ModelSpec {
  /** The API model id. */
  id: string;
  /** The value of `claude --model`. Haiku has no alias: `haiku` may mean 4.5 or 5.5, so the full id goes through. */
  cli: string;
  /** Whether the model takes adaptive thinking and an effort. */
  takesEffort: boolean;
  /** Whether the server-side fallback applies to the model. */
  fallback: boolean;
}

/** The built-in models. An id that is not in the list takes effort and goes to the CLI as it is. */
const KNOWN_MODELS: readonly ModelSpec[] = [
  { id: "claude-haiku-4-5", cli: "claude-haiku-4-5", takesEffort: false, fallback: false },
  { id: "claude-haiku-5-5", cli: "claude-haiku-5-5", takesEffort: true, fallback: false },
  { id: "claude-sonnet-5-5", cli: "sonnet", takesEffort: true, fallback: true },
  { id: "claude-opus-5-5", cli: "opus", takesEffort: true, fallback: true },
];

/** The fallback rule for an id that is not in `KNOWN_MODELS`: the families that take the server-side fallback. */
const FALLBACK_FAMILY = /(sonnet-5-5|opus-5|fable|mythos)/i;

const byId = new Map(KNOWN_MODELS.map((m) => [m.id, m]));

/**
 * Tells which request features a model takes. Haiku 4.5 takes no adaptive thinking, no effort and no fallback.
 * Every other model takes thinking; the fallback follows the table, or `FALLBACK_FAMILY` for an unknown id.
 *
 * @param model - the API model id
 * @returns whether to send thinking with an effort, and whether to ask for the server-side fallback
 * @sideEffects none
 */
export function modelFeatures(model: string): { thinking: boolean; fallback: boolean } {
  const known = byId.get(model);
  if (known) return { thinking: known.takesEffort, fallback: known.takesEffort && known.fallback };
  return { thinking: true, fallback: FALLBACK_FAMILY.test(model) };
}

/**
 * Maps a model id to the alias of `claude --model`. An id that is not in the table goes through as it is.
 *
 * @param model - the API model id
 * @returns the CLI alias, or the id itself
 * @sideEffects none
 */
export function cliModel(model: string): string {
  return byId.get(model)?.cli ?? model;
}
