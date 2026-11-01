// The place of the deployment on this computer (technical/release.md, "Ship a release"): shared by the deploy scripts and
// by the postdeploy evals, which find the local environment here.
import { join } from "node:path";

/** The port of the service. */
export const SERVICE_PORT = 7777;

/** The paths of the deployment folder. */
export interface DeployPaths {
  root: string;
  wikis: string;
  logs: string;
  startScript: string;
  taskScript: string;
}

/**
 * Names the places of the deployment folder.
 *
 * @param home - the home directory of the user
 * @returns `<home>/wikifact` and its `wikis`, `wikis/.logs`,`start-service.cmd` and `start-service.ps1`
 * @sideEffects none
 */
export function deployPaths(home: string): DeployPaths {
  const root = join(home, "wikifact");
  return {
    root,
    wikis: join(root, "wikis"),
    logs: join(root, "wikis", ".logs"),
    startScript: join(root, "start-service.cmd"),
    taskScript: join(root, "start-service.ps1"),
  };
}
