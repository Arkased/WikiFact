import { ChangeOutcome } from "../../src/domain/index.js";
import { seedChange, type FactDraft, type Store } from "../../src/store/index.js";
import { seededRandom } from "../../fakes/stub-consumer.js";

/** The seed of the fact generator, so that every run builds the same wiki. */
const FACT_SEED = 12345;

/** The seed of the query generator, so that a reused database gets the same queries. */
const QUERY_SEED = 987654321;

/** Facts per change when seeding. One change is one transaction and one embedder batch. */
const FACTS_PER_CHANGE = 100;

/** The seed prints a progress line every this many changes. */
const PROGRESS_EVERY_CHANGES = 10;

/** The largest value of the generated numbers in a fact text. */
const MAX_FACT_VALUE = 100;

/** The share of queries that are an entity and an attribute only; the rest also have a modifier. */
const SHORT_QUERY_SHARE = 0.5;

const MS_PER_SECOND = 1000;

/** The vocabulary of the synthetic wiki. */
const ENTITIES = [
  "creeper",
  "zombie",
  "skeleton",
  "spider",
  "enderman",
  "witch",
  "blaze",
  "ghast",
  "slime",
  "golem",
  "villager",
  "piglin",
  "drowned",
  "phantom",
  "guardian",
  "ocelot",
  "wolf",
  "horse",
  "pillager",
  "ravager",
];

/** The attributes of the synthetic wiki. */
const ATTRS = [
  "damage",
  "health",
  "speed",
  "spawn rate",
  "drop",
  "armor",
  "range",
  "cooldown",
  "knockback",
  "weakness",
  "hitbox",
  "sound",
  "biome",
  "light level",
  "burn time",
  "reach",
];

/** The modifiers of the synthetic wiki. */
const MODS = [
  "in the overworld",
  "on hard difficulty",
  "at night",
  "in caves",
  "near water",
  "in the nether",
  "in villages",
  "when charged",
  "with a sword",
  "in daylight",
];

const pick = <T>(rand: () => number, xs: T[]): T => {
  const x = xs[Math.floor(rand() * xs.length)];
  if (x === undefined) throw new Error("pick: the list is empty");
  return x;
};

function factText(rand: () => number, i: number): FactDraft {
  const entity = pick(rand, ENTITIES);
  const attr = pick(rand, ATTRS);
  const mod = pick(rand, MODS);
  return {
    header: `${entity} ${attr} ${mod} ${i}`,
    content: `The ${entity} has a ${attr} of ${Math.floor(rand() * MAX_FACT_VALUE)} ${mod}, measured in test world ${i}.`,
    justification: `Observed in world ${i}.`,
    references: [],
  };
}

/**
 * Seeds synthetic facts into a store, `FACTS_PER_CHANGE` per change, from fact number `from` up to `n`.
 *
 * @param store - the open store
 * @param range - `from` is how many facts the store has already, `n` the target count
 * @param range.from - the first fact number to write
 * @param range.n - the fact count to reach
 * @param log - receives a progress line every `PROGRESS_EVERY_CHANGES` changes
 * @sideEffects writes changes to the store through `seedChange`; the embedder runs; reads the clock
 */
export async function seedFacts(
  store: Store,
  range: { from: number; n: number },
  log: (line: string) => void,
): Promise<void> {
  const { from, n } = range;
  const rand = seededRandom(FACT_SEED);
  // Draw the facts again from the start, so that a resumed seed matches an uninterrupted one.
  for (let i = 0; i < from; i++) factText(rand, i);
  const t0 = Date.now();
  for (let i = from; i < n; i += FACTS_PER_CHANGE) {
    const facts: FactDraft[] = [];
    for (let j = i; j < Math.min(n, i + FACTS_PER_CHANGE); j++) facts.push(factText(rand, j));
    await seedChange(store, {
      outcome: ChangeOutcome.Accepted,
      summary: `seed ${i}`,
      changeReasoning: "seed",
      facts,
    });
    if ((i / FACTS_PER_CHANGE) % PROGRESS_EVERY_CHANGES === 0)
      log(`  ${Math.min(n, i + FACTS_PER_CHANGE)} / ${n}  (${((Date.now() - t0) / MS_PER_SECOND).toFixed(0)} s)`);
  }
  log(`seeded in ${((Date.now() - t0) / MS_PER_SECOND).toFixed(1)} s`);
}

/**
 * Makes the queries of the run: 2 to 3 words of the vocabulary, as a consumer types them.
 *
 * @param count - how many queries
 * @returns the queries; the same list for the same count
 * @sideEffects none
 */
export function makeQueries(count: number): string[] {
  const rand = seededRandom(QUERY_SEED);
  const queries: string[] = [];
  for (let i = 0; i < count; i++) {
    queries.push(
      rand() < SHORT_QUERY_SHARE
        ? `${pick(rand, ENTITIES)} ${pick(rand, ATTRS)}`
        : `${pick(rand, ENTITIES)} ${pick(rand, ATTRS)} ${pick(rand, MODS)}`,
    );
  }
  return queries;
}
