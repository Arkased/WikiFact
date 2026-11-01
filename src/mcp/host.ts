// technical/deployment.md, "Local mode": the host rule of the HTTP transport. Local mode serves the loopback only.
import { LOCAL_CONDITION } from "../config/index.js";
import { Mode } from "../domain/enums.js";

/** The address that `--host` takes when the option is absent: the loopback. */
export const DEFAULT_HOST = "127.0.0.1";

/** The hosts that a local-mode wiki may bind. */
const LOOPBACK_HOSTS: string[] = [DEFAULT_HOST, "localhost"];

/**
 * Checks the `--host` of the HTTP transport against the mode of a wiki.
 *
 * @param mode - the mode of the wiki, from its `wikifact.json`
 * @param host - the address to bind
 * @returns the refusal message when a local-mode wiki would be bound to an address other than `127.0.0.1` or
 *   `localhost`; `undefined` when the host is allowed. A deployed wiki may bind any address
 * @sideEffects none
 */
export function hostRefusal(mode: Mode, host: string): string | undefined {
  if (mode !== Mode.Local || LOOPBACK_HOSTS.includes(host)) return undefined;
  return `--host ${host} is refused in local mode (${LOCAL_CONDITION}). Local mode binds ${DEFAULT_HOST} or localhost only. Set "mode": "deployed" in wikifact.json to serve other machines.`;
}
