/** Thrown for a request that the registry refuses: a bad name, a twin, the cap, an unknown wiki or archive. */
export class WikiError extends Error {}

/**
 * Thrown when a wiki folder stays locked by another process after every retry. It is a `WikiError`, so a caller that
 * shows a refusal still catches it, but it is a fault of the service, not a refusal with a reason: the MCP tools count
 * it as a failed tool call (technical/deployment.md, "Endpoint counters").
 */
export class FolderLockedError extends WikiError {}
