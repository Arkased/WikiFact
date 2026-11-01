// Loaded with `node --import` into a spawned `serve`, so that the child process uses the fake embedder, not the model.
import { setEmbedder } from "../../src/embed/index.js";
import { fakeEmbed } from "../../fakes/fake-embedder.js";

setEmbedder(fakeEmbed);
