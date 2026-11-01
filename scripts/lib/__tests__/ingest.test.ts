// Unit tests of `scripts/lib/ingest.ts` with stub model and stub client: the wiki check, the parts of a long file, the
// refusal line and the cost of a failed call.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it } from "vitest";
import type { PriceTable } from "../../../src/config/index.js";
import { McpToolName, StopReason } from "../../../src/domain/enums.js";
import type { CallRequest, CallResponse, Transport } from "../../../src/updates/index.js";
import { EXTRACTION_MODEL, ingestFiles, MAX_PART_BYTES, splitParts } from "../ingest.js";

const PRICES: PriceTable = {
  cacheWriteFactor: 1,
  cacheReadFactor: 1,
  models: { [EXTRACTION_MODEL]: { input: 1e6, output: 2e6 } },
};
const USAGE = { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 };
const CALL_COST = "$5.000";

interface Setup {
  dir: string;
  lines: string[];
  requests: CallRequest[];
  toolCalls: string[];
  run: (files: string[], reply: (req: CallRequest) => Partial<CallResponse>, refuse?: string) => Promise<number>;
}

function setup(wikis: string[] = ["game"]): Setup {
  const s: Setup = {
    dir: mkdtempSync(join(tmpdir(), "wikifact-ingest-")),
    lines: [],
    requests: [],
    toolCalls: [],
    run: () => Promise.resolve(1),
  };
  s.run = async (files, reply, refuse) => {
    const transport: Transport = {
      send: (req) => {
        s.requests.push(req);
        return Promise.resolve({ stopReason: null, text: "", usage: USAGE, ...reply(req) });
      },
    };
    const client: Pick<Client, "callTool"> = {
      callTool: (params) => {
        s.toolCalls.push(params.name);
        if (params.name === String(McpToolName.ListWikis)) {
          return Promise.resolve({ content: [], structuredContent: { wikis: wikis.map((name) => ({ name })) } });
        }
        if (refuse !== undefined) return Promise.resolve({ isError: true, content: [{ type: "text", text: refuse }] });
        return Promise.resolve({ content: [], structuredContent: { requestId: "r" } });
      },
    };
    const report = await ingestFiles({
      wiki: "game",
      files,
      cwd: s.dir,
      transport,
      prices: PRICES,
      client,
      print: (l) => s.lines.push(l),
    });
    return report.exitCode;
  };
  return s;
}

it("stops before any model call when the service holds no such wiki", async () => {
  const s = setup(["other"]);
  writeFileSync(join(s.dir, "a.md"), "One.\n");
  await expect(s.run(["a.md"], () => ({ text: '{"claims":[]}' }))).rejects.toThrow(/no wiki named game/);
  expect(s.requests).toHaveLength(0);
  expect(s.toolCalls).toEqual([String(McpToolName.ListWikis)]);
});

it("prints the tool text of a refused claim and counts it as failed", async () => {
  const s = setup();
  writeFileSync(join(s.dir, "a.md"), "One.\nTwo.\n");
  const code = await s.run(["a.md"], () => ({ text: '{"claims":[{"claim":"One.","line":1}]}' }), "claim too long");
  expect(s.lines[0]).toBe("a.md: line 1: not queued (claim too long)");
  expect(s.lines[1]).toMatch(/^a\.md: 0 claims queued, 0 dropped, 1 failed, \$5\.000$/);
  expect(code).toBe(1);
});

it("counts the cost of a call that hit the token limit", async () => {
  const s = setup();
  writeFileSync(join(s.dir, "a.md"), "One.\n");
  const code = await s.run(["a.md"], () => ({ stopReason: StopReason.MaxTokens }));
  expect(s.lines[0]).toBe(`a.md: error: the answer hit the token limit, ${CALL_COST}`);
  expect(s.lines.at(-1)).toContain(CALL_COST);
  expect(code).toBe(1);
});

it("counts the cost of an answer that fails the schema", async () => {
  const s = setup();
  writeFileSync(join(s.dir, "a.md"), "One.\n");
  await s.run(["a.md"], () => ({ text: '{"nope":1}' }));
  expect(s.lines[0]).toMatch(/^a\.md: error: .*, \$5\.000$/s);
  expect(s.lines.at(-1)).toContain(CALL_COST);
});

it("splits the lines into parts at line breaks, each at most the limit", () => {
  const line = "x".repeat(99); // 100 bytes with its line break
  const per = MAX_PART_BYTES / 100;
  const parts = splitParts(Array.from({ length: per * 2 + 1 }, () => line));
  expect(parts.map((p) => [p.firstLine, p.lines.length])).toEqual([
    [1, per],
    [per + 1, per],
    [2 * per + 1, 1],
  ]);
  const long = "y".repeat(MAX_PART_BYTES + 5);
  expect(splitParts(["a", long, "b"]).map((p) => p.lines.length)).toEqual([1, 1, 1]);
  expect(splitParts([])).toEqual([]);
});

it("reads a long file in parts with the line numbers of the file and sums the cost", async () => {
  const s = setup();
  const per = MAX_PART_BYTES / 100;
  const text = Array.from({ length: per + 3 }, (_, i) => `${String(i + 1).padStart(99, "0")}`).join("\n");
  writeFileSync(join(s.dir, "a.md"), text);
  const code = await s.run(["a.md"], (req) => {
    const numbers = (req.messages[0]?.content ?? "")
      .split("\n")
      .slice(1)
      .map((l) => Number(l.split("\t")[0]));
    const first = numbers[0] ?? 0;
    return { text: JSON.stringify({ claims: [{ claim: `Part from ${first}.`, line: first }] }) };
  });
  const sent = s.requests.map((r) => r.messages[0]?.content ?? "");
  expect(sent).toHaveLength(2);
  expect(sent.every((m) => m.startsWith("File: a.md\n"))).toBe(true);
  expect(sent[0]).toContain(`\n${per}\t`);
  expect(sent[1]).toContain(`\n${per + 1}\t`);
  expect(sent[1]).toContain(`\n${per + 3}\t`);
  expect(s.lines).toEqual([
    "a.md: 2 claims queued, 0 dropped, $10.000",
    "total: 1 files, 2 claims queued, 0 dropped, $10.000",
  ]);
  expect(code).toBe(0);
});
