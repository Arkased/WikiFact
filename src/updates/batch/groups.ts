// technical/updates.md, "High volume mode", "Run", stage 2: code groups the requests of a round before the group call.
import { cosineDistance, embed } from "../../embed/index.js";

/** The request fields that the grouping reads. */
export interface GroupRequest {
  id: string;
  /** The text of the change; null for a row with none. */
  change: string | null;
}

/**
 * Groups requests by the embeddings of their change text. A group is a connected set of links; 2 requests are linked when the
 * cosine distance of their 2 vectors is under `cut` (union-find).
 *
 * @param ids - the request ids, in queue order
 * @param vectors - one vector for each id, in the same order
 * @param cut - the cosine distance under which 2 requests are linked (`highVolume.groupCut`)
 * @returns the groups ordered by their first request; each group lists its request ids in queue order
 * @sideEffects none
 */
function groupVectors(ids: string[], vectors: Float32Array[], cut: number): string[][] {
  const parent = ids.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while ((parent[root] ?? root) !== root) root = parent[root] ?? root;
    // Path compression: a later find on a node of this chain is 1 step.
    for (let node = i; node !== root;) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  for (const [i, a] of vectors.entries()) {
    for (let j = 0; j < i; j++) {
      const b = vectors[j];
      if (b !== undefined && cosineDistance(a, b) < cut) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map<number, string[]>();
  for (const [i, id] of ids.entries()) {
    const root = find(i);
    const group = byRoot.get(root);
    if (group === undefined) byRoot.set(root, [id]);
    else group.push(id);
  }
  // A group is created at its first request, so the order of the map is the order of the groups.
  return [...byRoot.values()];
}

/**
 * Groups the requests of a round (stage 2 of the run): embeds the change text of each request with the embedder of the store
 * index and links the requests whose vectors are close.
 *
 * @param requests - the requests of the round, in queue order
 * @param cut - the cosine distance under which 2 requests are linked (`highVolume.groupCut`)
 * @returns the groups, each a list of request ids in queue order, ordered by their first request; every request is in 1 group
 * @sideEffects runs the embedder; no model call
 */
export async function groupRequests(requests: GroupRequest[], cut: number): Promise<string[][]> {
  if (requests.length === 0) return [];
  const vectors = await embed(requests.map((r) => r.change ?? ""));
  return groupVectors(
    requests.map((r) => r.id),
    vectors,
    cut,
  );
}
