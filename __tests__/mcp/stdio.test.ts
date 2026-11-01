// End to end: `serve --db <file>` over stdio, driven by the script `scripts/mcp-client.ts`. The stdio process is 1 session.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { runClient } from "../../scripts/mcp-client.js";
import { parseConfig } from "../../src/config/index.js";
import { McpToolName } from "../../src/domain/index.js";
import { closeStore, openStoreFor } from "../../src/store/index.js";
import { accepted, draft, write } from "../helpers/store.js";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

const ROOT = resolve(import.meta.dirname, "../..");

interface SessionRow {
  call_count: number;
  ended_at: number | null;
}

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wikifact-stdio-"));
  db = join(dir, "wiki.sqlite");
  const store = openStoreFor(parseConfig({}), db);
  write(
    store,
    accepted([draft({ header: "Creeper damage", content: "A creeper explosion does damage." })]),
    Date.now(),
  );
  closeStore(store);
});
describe("serve over stdio, driven by the mcp-client script", () => {
  it(
    "lists the tools, answers every call, and leaves one ended session row that counted the calls",
    async () => {
      const report = await runClient({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "--import",
          pathToFileURL(join(ROOT, "__tests__/helpers/preload-fake-embedder.ts")).href,
          join(ROOT, "src/cli.ts"),
          "serve",
          "--db",
          db,
        ],
        cwd: ROOT,
        show: () => undefined,
        stderr: "ignore",
      });
      expect(report.tools).toEqual(expect.arrayContaining([McpToolName.Search, McpToolName.GetFact]));
      expect(report.calls).toBeGreaterThan(0);

      const store = openStoreFor(parseConfig({}), db);
      const rows = store.db.prepare("SELECT * FROM sessions").all() as SessionRow[];
      closeStore(store);
      expect(rows).toHaveLength(1);
      expect(rows[0].call_count).toBe(report.calls);
      expect(rows[0].ended_at).not.toBeNull();
    },
    PROCESS_START_TIMEOUT_MS,
  );
});
