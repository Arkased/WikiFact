import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CleanupFinder } from "../../domain/enums.js";
import {
  cleanupCandidates,
  closeStore,
  enqueueCleanupRepair,
  finishRequest,
  seedChange,
  verdictSubject,
  versionText,
  writeVerdicts,
  type Store,
  type CleanupRepair,
} from "../index.js";
import { fakeVector } from "../../../fakes/fake-embedder.js";
import { T0, accepted, draft, makeStore } from "../../../__tests__/helpers/store.js";

let store: Store;
let clock: number;
beforeEach(() => {
  store = makeStore();
  clock = T0;
});
afterEach(() => closeStore(store));

// Writes 1 fact in its own change, so the facts differ in age; the fake embedder gives close vectors to texts that share words.
async function put(over: Parameters<typeof draft>[0]): Promise<string> {
  clock += 1;
  const res = await seedChange(store, accepted([draft(over)]), { now: clock });
  const [id] = res.factIds;
  if (id === undefined) throw new Error("no fact written");
  return id;
}

const fuse = (header: string, content: string): Parameters<typeof draft>[0] => ({ header, content });

// A and B are the closest pair, then A and C, then B and C; the zombie fact is far from all of them.
async function seedFuses(): Promise<{ a: string; b: string; c: string; z: string }> {
  const a = await put(fuse("Creeper fuse time", "A creeper fuse burns for 1.5 seconds."));
  const b = await put(fuse("Creeper fuse duration", "A creeper fuse burns for 1.5 seconds."));
  const c = await put(fuse("Creeper fuse time", "A creeper fuse burns for 3 seconds."));
  const z = await put(fuse("Zombie moan", "Zombies moan loudly at night."));
  return { a, b, c, z };
}

const pairs = (limits: Parameters<typeof cleanupCandidates>[1] = {}): CleanupRepair[] =>
  cleanupCandidates(store, limits, [CleanupFinder.DuplicateFact]).candidates;

describe("the duplicate fact finder", () => {
  it("returns 1 candidate per pair, the older fact first, the closest pair first, and no far fact", async () => {
    const { a, b, c } = await seedFuses();
    expect(pairs()).toEqual([
      { finder: CleanupFinder.DuplicateFact, factIds: [a, b] },
      { finder: CleanupFinder.DuplicateFact, factIds: [a, c] },
      { finder: CleanupFinder.DuplicateFact, factIds: [b, c] },
    ]);
  });

  it("takes only the nearest facts of each fact", async () => {
    const { a, b, c } = await seedFuses();
    // The nearest fact of A is B, of B is A, and of C is A: the pair of B and C is nobody's nearest.
    expect(pairs({ duplicateFactNeighbors: 1 })).toEqual([
      { finder: CleanupFinder.DuplicateFact, factIds: [a, b] },
      { finder: CleanupFinder.DuplicateFact, factIds: [a, c] },
    ]);
  });

  it("keeps a pair under the neighbor distance of the config and drops the others", async () => {
    const { a, b } = await seedFuses();
    const [va, vb, vc] = [
      fakeVector(versionText("Creeper fuse time", "A creeper fuse burns for 1.5 seconds.")),
      fakeVector(versionText("Creeper fuse duration", "A creeper fuse burns for 1.5 seconds.")),
      fakeVector(versionText("Creeper fuse time", "A creeper fuse burns for 3 seconds.")),
    ];
    const distance = (x: Float32Array | undefined, y: Float32Array | undefined): number => {
      let dot = 0;
      for (let i = 0; i < (x?.length ?? 0); i++) dot += (x?.[i] ?? 0) * (y?.[i] ?? 0);
      return 1 - dot;
    };
    const closest = distance(va, vb);
    const next = distance(va, vc);
    expect(closest).toBeLessThan(next);
    store.config.neighborDistance = closest / 2;
    expect(pairs()).toEqual([]);
    store.config.neighborDistance = (closest + next) / 2;
    expect(pairs()).toEqual([{ finder: CleanupFinder.DuplicateFact, factIds: [a, b] }]);
  });

  it("leaves out a deleted fact", async () => {
    const { a, b, c } = await seedFuses();
    clock += 1;
    await seedChange(
      store,
      accepted([
        draft({ factId: c, ...fuse("Creeper fuse time", "A creeper fuse burns for 3 seconds."), isDeleted: true }),
      ]),
      { now: clock },
    );
    expect(pairs()).toEqual([{ finder: CleanupFinder.DuplicateFact, factIds: [a, b] }]);
  });

  it("skips a pair that a verdict covers until a new version of either fact", async () => {
    const { a, b } = await seedFuses();
    writeVerdicts(store, CleanupFinder.DuplicateFact, [verdictSubject([b, a])], clock);
    expect(pairs().map((p) => (p.finder === CleanupFinder.DuplicateFact ? p.factIds : []))).not.toContainEqual([a, b]);
    clock += 1;
    await seedChange(
      store,
      accepted([
        draft({ factId: b, ...fuse("Creeper fuse duration", "A creeper fuse burns for 1.5 seconds, edited.") }),
      ]),
      { now: clock },
    );
    expect(pairs().map((p) => (p.finder === CleanupFinder.DuplicateFact ? p.factIds : []))).toContainEqual([a, b]);
  });

  it("skips a pair that a queued cleanupRepair holds, and takes it again once the request is done", async () => {
    const { a, b } = await seedFuses();
    const doc: CleanupRepair = { finder: CleanupFinder.DuplicateFact, factIds: [a, b] };
    const id = enqueueCleanupRepair(store, doc, clock);
    expect(pairs()).not.toContainEqual(doc);
    finishRequest(store, id, clock + 1);
    expect(pairs()).toContainEqual(doc);
  });

  it("stops at the cap and reports the finder as cut", async () => {
    await seedFuses();
    const res = cleanupCandidates(store, { cap: 1 }, [CleanupFinder.DuplicateFact]);
    expect(res.candidates).toHaveLength(1);
    expect(res.cut).toEqual([CleanupFinder.DuplicateFact]);
  });
});
