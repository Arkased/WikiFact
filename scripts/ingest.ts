// Usage: npm run ingest -- --wiki <name> <file> [<file> ...]
// Reads each text file with one model call, and queues each claim it states as one `requestChange` on the management
// endpoint of the local service (docs/technical/ingest.md). Calls the model and adds requests to the queue of the wiki.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ARGV_USER_OFFSET } from "../src/constants.js";
import { hasCredentials } from "../eval/lib/credentials.js";
import { parseCommandLine } from "../eval/lib/args.js";
import { isMain } from "../eval/lib/main.js";
import { loadPrices } from "../src/config/index.js";
import { EXIT_USAGE, NO_CREDENTIALS_EXIT_CODE } from "../src/constants.js";
import { CallerKind } from "../src/domain/enums.js";
import { loadEnvFile, readEnv } from "../src/env.js";
import { errorMessage } from "../src/must.js";
import { selectTransport } from "../src/updates/index.js";
import { MCP_URL } from "./deploy.js";
import { ingestFiles } from "./lib/ingest.js";

async function main(): Promise<number> {
  loadEnvFile();
  const args = parseCommandLine(process.argv.slice(ARGV_USER_OFFSET), { options: ["wiki"] });
  const wiki = args.options.get("wiki");
  if (wiki === undefined || wiki === "" || args.positionals.length === 0) {
    console.error("Usage: npm run ingest -- --wiki <name> <file> [<file> ...]");
    return EXIT_USAGE;
  }
  if (!hasCredentials(readEnv())) {
    console.error("Blocked: no Anthropic credentials found. Set ANTHROPIC_API_KEY, or run `ant auth login`.");
    return NO_CREDENTIALS_EXIT_CODE;
  }
  const client = new Client({ name: "ingest", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  } catch (e) {
    console.error(`Cannot reach the service at ${MCP_URL}: ${errorMessage(e)}`);
    return 1;
  }
  try {
    const report = await ingestFiles({
      wiki,
      files: args.positionals,
      cwd: process.cwd(),
      transport: selectTransport(CallerKind.Eval, readEnv()).transport,
      prices: loadPrices(),
      client,
      print: (line) => console.log(line),
    });
    return report.exitCode;
  } finally {
    await client.close();
  }
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      console.error(errorMessage(e));
      process.exitCode = 1;
    });
}
