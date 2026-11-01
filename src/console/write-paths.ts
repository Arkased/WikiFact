// The one definition of the POST routes of technical/console.md, "Operator actions" and "Direct edits of non-request fields": the route table and the forms both read it, so a
// form cannot post to a path that no route serves.
import { ConsoleAction, assertNever } from "../domain/enums.js";
import { fillTemplate } from "./template.js";

/**
 * Gives the path template of an action's POST route.
 *
 * @param action - the action whose route the table serves; the switch has no default, so a new member fails to compile
 * @returns the template, with `:w` for the wiki and `:id` for the request
 * @sideEffects none
 */
export function actionTemplate(action: ConsoleAction): string {
  switch (action) {
    case ConsoleAction.Reindex:
      return "/console/w/:w/jobs/reindex";
    case ConsoleAction.CreateWiki:
      return "/console/wikis";
    case ConsoleAction.ArchiveWiki:
      return "/console/w/:w/archive";
    case ConsoleAction.UnarchiveWiki:
      return "/console/w/:w/unarchive";
    case ConsoleAction.RunCleanup:
      return "/console/w/:w/jobs/cleanup";
    case ConsoleAction.SetDescription:
      return "/console/w/:w/settings/description";
    case ConsoleAction.UpdateConfig:
      return "/console/w/:w/settings/config";
    case ConsoleAction.RenameWiki:
      return "/console/w/:w/settings/rename";
    case ConsoleAction.PauseQueue:
      return "/console/w/:w/health/pause";
    case ConsoleAction.ResumeQueue:
      return "/console/w/:w/health/resume";
    case ConsoleAction.RunBatch:
      return "/console/w/:w/health/batch";
  }
  return assertNever(action);
}

/**
 * Builds the URL a form posts to.
 *
 * @param action - the action the form starts
 * @param params - the wiki in `w` and, for a request action, the object in `id`; each value is path-escaped
 * @returns the path with the parameters filled in
 * @sideEffects none
 */
export function actionPath(action: ConsoleAction, params: Record<string, string> = {}): string {
  return fillTemplate(actionTemplate(action), params);
}
