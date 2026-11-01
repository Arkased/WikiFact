import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config/index.js";
import { McpToolName } from "../../domain/enums.js";
import { FolderLockedError, WikiError } from "../../service/errors.js";
import { closeStore, openStoreFor, type Store } from "../../store/index.js";
import { ToolError, runTool } from "../tools.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-runtool-"));
  store = openStoreFor(parseConfig({ embeddingModel: "test-model" }), join(dir, "wiki.sqlite"));
});
afterEach(() => {
  closeStore(store);
});

const okOf = async (fn: () => object): Promise<{ isError: boolean | undefined; ok: unknown }> => {
  const result = await runTool({ log: () => undefined, store }, McpToolName.GetFact, {}, fn);
  const row = store.db.prepare("SELECT ok FROM tool_calls").get() as { ok: number };
  store.db.exec("DELETE FROM tool_calls");
  return { isError: result.isError, ok: row.ok };
};

describe('runTool records the outcome (technical/deployment.md, "Endpoint counters")', () => {
  it("records ok for an answer", async () => {
    expect(await okOf(() => ({}))).toEqual({ isError: undefined, ok: 1 });
  });

  it("records ok for a rejection and still returns a tool error", async () => {
    expect(
      await okOf(() => {
        throw new ToolError("no fact with id");
      }),
    ).toEqual({ isError: true, ok: 1 });
    expect(
      await okOf(() => {
        throw new WikiError("no wiki named x");
      }),
    ).toEqual({ isError: true, ok: 1 });
  });

  it("records not ok for a folder that stays locked, which is a fault of the service", async () => {
    expect(
      await okOf(() => {
        throw new FolderLockedError("could not remove: the folder is still locked");
      }),
    ).toEqual({ isError: true, ok: 0 });
  });

  it("records not ok for an unexpected error", async () => {
    expect(
      await okOf(() => {
        throw new Error("disk I/O error");
      }),
    ).toEqual({ isError: true, ok: 0 });
  });
});
