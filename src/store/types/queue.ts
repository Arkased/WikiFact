import type { RequestKind, RequestStatus } from "../../domain/enums.js";
import type { OperatorEdit } from "./operator-edit.js";

/** technical/updates.md, "Queue and worker". One row of `change_requests`. */
export interface ChangeRequestRow {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  change: string | null;
  targets: string[];
  justification: string | null;
  /** The id of the search that the change follows; null when the call named none. */
  searchId: string | null;
  attempts: number;
  /** Time the request was received, in ms since the epoch. */
  receivedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** The submission that a split made this request from; null for every other request. A child is never split again. */
  parentId: string | null;
  /** The parsed `change` document of an `operatorEdit` row; absent for another kind and for a document that is invalid. */
  operatorEdit?: OperatorEdit;
}

/** technical/updates.md, "Queue and worker". The attempts a request gets before it is marked `failed`. */
export const MAX_ATTEMPTS = 3;
