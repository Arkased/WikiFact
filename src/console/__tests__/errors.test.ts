import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConsoleErrorKind } from "../../domain/enums.js";
import type { ConsoleDeps } from "../deps.js";
import { ConsoleError, errorPage, statusOf, toConsoleError, unknownWiki } from "../errors.js";
import { parse } from "./helpers/dom.js";

describe("errorPage", () => {
  const deps = { listWikis: () => [{ name: "alpha" }] } as unknown as ConsoleDeps;

  it("shows the status as the heading and the escaped message as a bad notice, inside the frame", () => {
    const page = parse(errorPage(deps, new ConsoleError(ConsoleErrorKind.NotFound, "no <wiki>"), 404));
    expect(page.headings("h1")[0]).toContain("Error 404");
    expect(page.title).toBe("Error 404 - WikiFact");
    expect(page.text).toContain("no <wiki>");
    expect(page.$("wiki")).toBeNull();
    // The shell stays: the brand links to the wikis page.
    expect(page.href("WikiFact")).toBe("/console/");
  });

  it("still renders when the wiki list cannot be read", () => {
    const broken = {
      listWikis: () => {
        throw new Error("gone");
      },
    } as unknown as ConsoleDeps;
    expect(errorPage(broken, new ConsoleError(ConsoleErrorKind.Other, "boom"), 500)).toContain("boom");
  });
});

describe("statusOf", () => {
  it("maps each kind to its status", () => {
    expect(statusOf(ConsoleErrorKind.BadQuery)).toBe(400);
    expect(statusOf(ConsoleErrorKind.NotFound)).toBe(404);
    expect(statusOf(ConsoleErrorKind.Refused)).toBe(409);
    expect(statusOf(ConsoleErrorKind.Other)).toBe(500);
  });
});

describe("toConsoleError", () => {
  it("keeps a ConsoleError", () => {
    const e = unknownWiki("nope");
    expect(toConsoleError(e)).toBe(e);
    expect(e.kind).toBe(ConsoleErrorKind.NotFound);
    expect(e.message).toContain('"nope"');
  });

  it("turns a zod error into a bad query with the issue in the message", () => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200) }).safeParse({ limit: "500" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const e = toConsoleError(parsed.error);
    expect(e.kind).toBe(ConsoleErrorKind.BadQuery);
    expect(e.message).toContain("limit");
  });

  it("turns any other error into a 500 with its message", () => {
    const e = toConsoleError(new Error("disk gone"));
    expect(e).toBeInstanceOf(ConsoleError);
    expect(e.kind).toBe(ConsoleErrorKind.Other);
    expect(e.message).toBe("disk gone");
    expect(toConsoleError("text").message).toBe("text");
  });
});
