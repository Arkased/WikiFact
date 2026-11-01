// The requirement tests of docs/requirements/ingest.md: one test for each row, named by the Name cell.
// The model is a stub transport; the service is a scratch management endpoint over a registry in a temp folder.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, expect, it } from "vitest";
import { EXTRACTION_MODEL, ingestFiles } from "../../scripts/lib/ingest.js";
import type { PriceTable } from "../../src/config/index.js";
import { COST_DECIMALS } from "../../src/constants.js";
import { McpToolName, RequestStatus } from "../../src/domain/enums.js";
import type { CallRequest, CallResponse, Transport } from "../../src/updates/index.js";
import { startManagement, type ManagementWorld } from "../helpers/mcp.js";

const WIKI = "game";

/** 1 USD per input token and 2 USD per output token, so the cost of a stub answer is a whole number. */
const PRICES: PriceTable = {
  cacheWriteFactor: 1,
  cacheReadFactor: 1,
  models: { [EXTRACTION_MODEL]: { input: 1e6, output: 2e6 } },
};
const STUB_INPUT_TOKENS = 3;
const STUB_OUTPUT_TOKENS = 1;
const STUB_COST_USD = STUB_INPUT_TOKENS + 2 * STUB_OUTPUT_TOKENS;

interface World {
  management: ManagementWorld;
  client: Client;
  dir: string;
  requests: CallRequest[];
  /** The `requestChange` arguments that reached the service, and the ids it returned. */
  sent: { args: Record<string, unknown>; requestId: string }[];
  lines: string[];
  run: (files: string[], answers: Record<string, unknown>) => Promise<number>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.management.close();
});

// Builds a scratch service with one wiki and a stub model that answers each file with `answers[file]`.
async function world(): Promise<World> {
  const management = startManagement({ [WIKI]: "A game." });
  const client = await management.connect();
  const dir = mkdtempSync(join(tmpdir(), "wikifact-req-ingest-"));
  const w: World = { management, client, dir, requests: [], sent: [], lines: [], run: () => Promise.resolve(1) };
  // The spy forwards to the real service and keeps what `requestChange` received and returned.
  const spy: Pick<Client, "callTool"> = {
    callTool: async (params) => {
      const res = await client.callTool(params);
      if (params.name === String(McpToolName.RequestChange)) {
        const out = res.structuredContent as { requestId: string };
        w.sent.push({ args: params.arguments ?? {}, requestId: out.requestId });
      }
      return res;
    },
  };
  w.run = async (files, answers) => {
    const transport: Transport = {
      send: (req: CallRequest): Promise<CallResponse> => {
        w.requests.push(req);
        const file = /^File: (.*)/.exec(req.messages[0]?.content ?? "")?.[1] ?? "";
        return Promise.resolve({
          stopReason: null,
          text: JSON.stringify(answers[file]),
          usage: { input: STUB_INPUT_TOKENS, output: STUB_OUTPUT_TOKENS, cacheRead: 0, cacheWrite: 0 },
        });
      },
    };
    const report = await ingestFiles({
      wiki: WIKI,
      files,
      cwd: dir,
      transport,
      prices: PRICES,
      client: spy,
      print: (line) => w.lines.push(line),
    });
    return report.exitCode;
  };
  worlds.push(w);
  return w;
}

it("Claims from a file", async () => {
  const w = await world();
  writeFileSync(join(w.dir, "a.md"), "# Creeper\nA creeper does 12 damage.\nIt explodes after 1.5 seconds.\n");
  writeFileSync(join(w.dir, "b.md"), "A zombie has 20 health.\n");
  const code = await w.run(["a.md", "b.md", "missing.md"], {
    "a.md": {
      claims: [
        { claim: "A creeper explosion does 12 damage.", line: 2 },
        { claim: "   ", line: 2 },
        { claim: "A creeper explodes 1.5 seconds after it ignites.", line: 3 },
        { claim: "A claim past the end of the file.", line: 99 },
      ],
    },
    "b.md": { claims: [{ claim: "A zombie has 20 health.", line: 1 }] },
  });

  // 1 model call per file that exists; the file text goes to the model with its line numbers.
  expect(w.requests).toHaveLength(2);
  expect(w.requests[0]?.messages[0]?.content).toContain("2\tA creeper does 12 damage.");
  // The claims with no text, or with a line outside the file, are dropped and counted; the missing file is an error.
  expect(w.sent.map((s) => [s.args.change, s.args.justification])).toEqual([
    ["A creeper explosion does 12 damage.", "Stated in a.md at line 2."],
    ["A creeper explodes 1.5 seconds after it ignites.", "Stated in a.md at line 3."],
    ["A zombie has 20 health.", "Stated in b.md at line 1."],
  ]);
  expect(w.lines.find((l) => l.startsWith("a.md:"))).toMatch(/2 claims queued, 2 dropped/);
  expect(w.lines.find((l) => l.startsWith("missing.md:"))).toContain("error");
  expect(code).toBe(1);
});

it("One request each", async () => {
  const w = await world();
  writeFileSync(join(w.dir, "a.md"), "Line one.\nLine two.\nLine three.\n");
  const code = await w.run(["a.md"], {
    "a.md": {
      claims: [
        { claim: "Third claim.", line: 3 },
        { claim: "First claim.", line: 1 },
        { claim: "Second claim.", line: 2 },
      ],
    },
  });

  // 1 request for each claim, queued in the order of the lines, with the file and the line as the justification.
  expect(w.sent.map((s) => s.args.change)).toEqual(["First claim.", "Second claim.", "Third claim."]);
  expect(w.sent.map((s) => s.args.justification)).toEqual([
    "Stated in a.md at line 1.",
    "Stated in a.md at line 2.",
    "Stated in a.md at line 3.",
  ]);
  expect(new Set(w.sent.map((s) => s.requestId)).size).toBe(w.sent.length);
  // The service holds each one as a queued request, as for a consumer.
  for (const s of w.sent) {
    const state = await w.client.callTool({
      name: McpToolName.GetRequest,
      arguments: { wiki: WIKI, requestId: s.requestId },
    });
    expect((state.structuredContent as { status: string }).status).toBe(RequestStatus.Queued);
  }
  expect(code).toBe(0);
});

it("Cost shown", async () => {
  const w = await world();
  writeFileSync(join(w.dir, "a.md"), "One.\nTwo.\n");
  writeFileSync(join(w.dir, "b.md"), "Three.\n");
  await w.run(["a.md", "b.md"], {
    "a.md": {
      claims: [
        { claim: "One.", line: 1 },
        { claim: "Two.", line: 2 },
      ],
    },
    "b.md": { claims: [{ claim: "Three.", line: 1 }] },
  });

  // 1 line for each file with its claims queued and the model cost; each short file costs one call.
  const cost = `$${STUB_COST_USD.toFixed(COST_DECIMALS)}`;
  expect(w.requests).toHaveLength(2);
  expect(w.lines.find((l) => l.startsWith("a.md:"))).toMatch(new RegExp(`2 claims queued.*\\${cost}`));
  expect(w.lines.find((l) => l.startsWith("b.md:"))).toMatch(new RegExp(`1 claims queued.*\\${cost}`));
  // The totals line adds the files.
  const total = `$${(2 * STUB_COST_USD).toFixed(COST_DECIMALS)}`;
  expect(w.lines.at(-1)).toMatch(new RegExp(`3 claims queued.*\\${total}`));
});
