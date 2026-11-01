import { describe, expect, it, vi } from "vitest";
import { ContextEvent } from "../../plugin/src/enums.js";
import { buildOutput, run } from "../../plugin/src/wiki-context.js";

const NAME = "fixture-wiki";

interface Out {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

describe("buildOutput", () => {
  it.each(Object.values(ContextEvent))("returns no output when the project has no wiki: %s", (event) => {
    expect(buildOutput({ hook_event_name: event }, null)).toBeNull();
  });

  it.each(Object.values(ContextEvent))("adds the wiki lines to the context of %s", (event) => {
    const out = buildOutput({ hook_event_name: event }, NAME) as Out;
    expect(out.hookSpecificOutput.hookEventName).toBe(event);
    const context = out.hookSpecificOutput.additionalContext;
    expect(context).toEqual(expect.any(String));
    expect(context).toContain(NAME);
  });

  it.each([{}, null, "text", { hook_event_name: "Stop" }, { hook_event_name: 3 }])(
    "throws when the input names no event that takes context: %j",
    (input) => {
      expect(() => buildOutput(input, NAME)).toThrow(/hook_event_name/);
    },
  );
});

describe("run", () => {
  const stdin = JSON.stringify({ hook_event_name: ContextEvent.SessionStart });

  it("returns the output when the project has a wiki", () => {
    const out = run(stdin, () => NAME, vi.fn()) as Out;
    expect(out.hookSpecificOutput.additionalContext).toContain(NAME);
  });

  it("returns null when the project has no config file or no wiki", () => {
    const log = vi.fn();
    expect(run(stdin, () => null, log)).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("returns null and logs on a fault", () => {
    const log = vi.fn();
    expect(run("not json", () => NAME, log)).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });
});
