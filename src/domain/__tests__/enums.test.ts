import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStore, type Store } from "../../store/index.js";
import { makeStore } from "../../../__tests__/helpers/store.js";
import {
  ChangeOutcome,
  QuestionId,
  RejectReason,
  RequestKind,
  RequestStatus,
  RetrievalKind,
  enumValues,
  isMember,
  questionMethod,
} from "../enums.js";

let store: Store;
beforeEach(() => {
  store = makeStore();
  // The rows below name parents that do not exist; only the enum constraint is under test.
  store.db.exec("PRAGMA foreign_keys = OFF");
});
afterEach(() => closeStore(store));

// An insert that sets one enum-backed column to the value of `?`.
interface Column {
  name: string;
  members: readonly string[];
  insert: string;
}

const columns: Column[] = [
  {
    name: "change_requests.kind",
    members: enumValues(RequestKind),
    insert: `INSERT INTO change_requests(id, kind, status, targets, received_at) VALUES (lower(hex(randomblob(8))), ?, '${RequestStatus.Queued}', '[]', 0)`,
  },
  {
    name: "change_requests.status",
    members: enumValues(RequestStatus),
    insert:
      "INSERT INTO change_requests(id, status, targets, received_at) VALUES (lower(hex(randomblob(8))), ?, '[]', 0)",
  },
  {
    name: "changes.outcome",
    members: enumValues(ChangeOutcome),
    insert: "INSERT INTO changes(request_id, outcome, summary, created_at) VALUES ('r', ?, 's', 0)",
  },
  {
    name: "changes.reject_reason",
    members: enumValues(RejectReason),
    insert: `INSERT INTO changes(request_id, outcome, reject_reason, summary, created_at) VALUES ('r', '${ChangeOutcome.Rejected}', ?, 's', 0)`,
  },
  {
    name: "retrievals.kind",
    members: enumValues(RetrievalKind),
    insert: "INSERT INTO retrievals(fact_version_id, at, kind) VALUES (1, 0, ?)",
  },
];

describe("the schema accepts the members of each enum and refuses any other value", () => {
  for (const c of columns) {
    it(c.name, () => {
      for (const m of c.members) expect(() => store.db.prepare(c.insert).run(m), m).not.toThrow();
      expect(() => store.db.prepare(c.insert).run("not-a-member")).toThrow();
    });
  }
});

describe("helpers", () => {
  it("isMember accepts a member and rejects others", () => {
    expect(isMember(RequestStatus, "queued")).toBe(true);
    expect(isMember(RequestStatus, "idle")).toBe(false);
    expect(isMember(RequestStatus, 3)).toBe(false);
  });
  it("questionMethod lower-cases the id", () => {
    expect(questionMethod(QuestionId.Q10)).toBe("q10");
  });
});
