// Unit tests never download the model: the fake embedder is the default in every test file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEmbedder } from "../src/embed/index.js";
import { fakeEmbed } from "../fakes/fake-embedder.js";

setEmbedder(fakeEmbed);

// Each test file gets a home folder of its own under the run folder (`tmpdir()`, set by `__tests__/global-setup.ts`).
// The files of a run run at the same time: with one shared home, a test that writes a fake deployment under it or lists
// it races with the other files. Child processes inherit the variables. The run folder is deleted at the end of the run.
const home = mkdtempSync(join(tmpdir(), "wikifact-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
