export const REASON: string;
export function wikiToolCalls(transcript: string): string[];
export function decide(
  input: { stop_hook_active?: boolean } | null | undefined,
  transcript: string,
): { decision: "block"; reason: string } | null;
