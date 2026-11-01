// End to end: `serve --wikis <dir> --http <port>` on a port that is in use prints the cause to stderr and exits with 1.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { PROCESS_START_TIMEOUT_MS } from "../helpers/timeouts.js";

const ROOT = resolve(import.meta.dirname, "../..");

let blocker: Server;
let port: number;
beforeAll(async () => {
  blocker = createServer();
  await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
  const address = blocker.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
});
afterAll(() => {
  blocker.close();
});

describe("serve on a port in use", () => {
  it(
    "prints the cause and the hint to stderr and exits with 1",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "wikifact-serve-error-"));
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          pathToFileURL(join(ROOT, "__tests__/helpers/preload-fake-embedder.ts")).href,
          join(ROOT, "src/cli.ts"),
          "serve",
          "--wikis",
          dir,
          "--http",
          String(port),
          "--host",
          "127.0.0.1",
        ],
        { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
      );
      onTestFinished(() => {
        child.kill();
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const code = await new Promise<number | null>((done) => child.once("exit", done));
      expect(code).toBe(1);
      expect(stderr).toContain("EADDRINUSE");
      expect(stderr).toContain(`port ${port} is in use; pass --http <other port>`);
    },
    PROCESS_START_TIMEOUT_MS,
  );
});
