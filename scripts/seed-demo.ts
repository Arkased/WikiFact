// `npm run demo:seed [-- path]`: creates ./wikis/demo/game.sqlite with 10 facts for the manual test of the
// MCP server. It deletes an existing file at that path. It uses the real embedder.
import { existsSync, rmSync } from "node:fs";
import { ChangeOutcome, Mode } from "../src/domain/index.js";
import { embed } from "../src/embed/index.js";
import { DEFAULT_DB_PATH } from "../src/paths.js";
import { closeStore, countFacts, newId, type FactDraft } from "../src/store/index.js";
import { isMain } from "../eval/lib/main.js";
import { seedWiki } from "../eval/lib/seed-wiki.js";

/** The parts of a demo fact. */
interface DemoFact {
  header: string;
  content: string;
  justification: string;
  /** Present for the facts that other facts refer to. */
  factId?: string;
  references?: string[];
}

const toDraft = (f: DemoFact): FactDraft => ({ ...f, references: f.references ?? [] });

// The 10 facts of the demo wiki.
function demoFacts(): FactDraft[] {
  const creeperDamage = newId();
  const playerHealth = newId();
  const facts: DemoFact[] = [
    {
      header: "Creeper damage",
      content: "A creeper explosion does 10 damage to an unarmored player.",
      justification: "I stood next to a creeper and lost 10 health.",
      factId: creeperDamage,
    },
    {
      header: "Creeper health",
      content: "A creeper has 20 health.",
      justification: "I hit one with a wooden sword and it died on the fifth hit.",
    },
    {
      header: "Creeper fuse",
      content: "A creeper explodes 1.5 seconds after it starts to hiss.",
      justification: "I timed the hiss with a stopwatch.",
    },
    {
      header: "Player health",
      content: "A player has 20 health.",
      justification: "The health bar shows 10 hearts, and each heart is 2 health.",
      factId: playerHealth,
    },
    {
      header: "Zombie damage",
      content: "A zombie hit does 3 damage to an unarmored player.",
      justification: "I took 3 damage from one zombie hit.",
    },
    {
      header: "Charged creeper kill",
      content: "A charged creeper kills an unarmored player in one hit.",
      justification: "I died to a charged creeper at full health.",
      references: [creeperDamage, playerHealth],
    },
    {
      header: "Wooden sword damage",
      content: "A wooden sword does 4 damage per hit.",
      justification: "A zombie with 20 health took 5 hits.",
    },
    {
      header: "Torch recipe",
      content: "A torch needs 1 coal and 1 stick and makes 4 torches.",
      justification: "I crafted a torch at the table and got 4.",
    },
    {
      header: "Bed recipe",
      content: "A bed needs 3 wool and 3 planks.",
      justification: "I opened the crafting table and made one with 3 wool and 3 planks.",
    },
    {
      header: "Crafting table recipe",
      content: "A crafting table needs 4 planks.",
      justification: "I made one from 4 planks in the 2 by 2 grid.",
    },
  ];
  return facts.map(toDraft);
}

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? DEFAULT_DB_PATH;
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);

  await embed(["warm up"]);
  // Local mode (technical/deployment.md, "Local mode") makes the manual test work in one step. An existing config is left alone.
  const { store, wroteConfig } = await seedWiki({
    dbPath,
    subject: "A block-building survival game",
    change: {
      outcome: ChangeOutcome.Accepted,
      summary: "Seed the demo wiki",
      changeReasoning: "Demo data.",
      facts: demoFacts(),
    },
    justification: "demo seed",
  });
  try {
    if (wroteConfig !== undefined) console.log(`wrote ${wroteConfig} with "mode": "${Mode.Local}"`);
    console.log(`seeded ${dbPath}: ${countFacts(store)} facts`);
  } finally {
    closeStore(store);
  }
}

if (isMain(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
