// The pure part of scripts/console-timing.ts: the bar and the check against it.

/** The bar of technical/console.md, "Non-functional rules", in ms. */
export const BAR_MS = 1000;

/** One console page and the wall time of its render. */
export interface TimedPage {
  page: string;
  ms: number;
}

/**
 * Picks the pages that miss the bar.
 *
 * @param pages - the timed pages
 * @param bar - the bar in ms; a page passes only under it
 * @returns the pages at or over the bar, in the order given
 * @sideEffects none
 */
export function slowPages(pages: TimedPage[], bar: number): TimedPage[] {
  return pages.filter((p) => p.ms >= bar);
}
