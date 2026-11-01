/**
 * The timeout of a test, or of a hook, that starts a real child process, in milliseconds. The start of a `tsx` or node
 * process alone takes seconds while the rest of `npm run check` loads the machine; it is not a bound under test.
 */
export const PROCESS_START_TIMEOUT_MS = 60_000;

/**
 * The timeout of a test that runs real work over the question sets or the replay cases (`runSets`, a full set, the
 * replay harness), in milliseconds. Alone the work takes well under a second; the bound is the load of a parallel
 * `npm run check`, not the work itself.
 */
export const HEAVY_TEST_TIMEOUT_MS = 30_000;
