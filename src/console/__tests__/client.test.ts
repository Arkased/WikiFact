// @vitest-environment jsdom
// The browser script of technical/console.md, "Architecture", loaded from source into a jsdom document. The script is a classic script
// that wires itself at load, so each test sets the page up first and then loads a fresh copy of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The refresh period the test pages ask for, in seconds. */
const REFRESH_SECONDS = 15;

const PAGE = (extra: string, refresh = true): string => `
  <main ${refresh ? `data-refresh="${REFRESH_SECONDS}"` : ""}>
    <p id="content">old</p>
    <input data-search id="search" value="" />
    ${extra}
  </main>`;

/** The page the stubbed fetch returns, with a different `main`. */
const NEXT_PAGE = `<!doctype html><html><body><main data-refresh="${REFRESH_SECONDS}"><p id="content">new</p></main></body></html>`;

// A classic script has no exports, so TypeScript does not take it as a module; the path in a variable keeps the
// import a plain side-effect load.
const SCRIPT = "../client/console.ts";

// The listeners that a load put on the document, so that each test removes them and the next load starts clean.
let listeners: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];

async function loadScript(): Promise<void> {
  vi.resetModules();
  const add = document.addEventListener.bind(document);
  const spy = vi
    .spyOn(document, "addEventListener")
    .mockImplementation(
      (type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
        listeners.push([type, fn, o]);
        add(type, fn, o);
      },
    );
  try {
    await import(SCRIPT);
  } finally {
    spy.mockRestore();
  }
}

// Runs the timer of the refresh and lets the stubbed fetch and the swap finish.
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(REFRESH_SECONDS * 1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom does not implement scrolling.
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(NEXT_PAGE))),
  );
});

afterEach(() => {
  for (const [type, fn, options] of listeners) document.removeEventListener(type, fn, options);
  listeners = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const content = (): string => document.getElementById("content")?.textContent ?? "";

describe("the refresh of main", () => {
  it("replaces the content of main every period when nothing is being edited", async () => {
    document.body.innerHTML = PAGE("");
    await loadScript();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(content()).toBe("new");
  });

  it("does nothing on a page without data-refresh", async () => {
    document.body.innerHTML = PAGE("", false);
    await loadScript();
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(content()).toBe("old");
  });

  it("skips while a field in main holds a changed value", async () => {
    document.body.innerHTML = PAGE('<textarea id="note">kept</textarea>');
    const note = document.getElementById("note") as HTMLTextAreaElement;
    note.value = "half-typed";
    await loadScript();
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(content()).toBe("old");
    note.value = note.defaultValue;
    await tick();
    expect(content()).toBe("new");
  });

  it("skips while a field has the focus", async () => {
    document.body.innerHTML = PAGE("");
    (document.getElementById("search") as HTMLInputElement).focus();
    await loadScript();
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(content()).toBe("old");
  });

  it("skips while a dialog is open and resumes when it closes", async () => {
    document.body.innerHTML = PAGE('<dialog class="sheet" id="d" open><p>form</p></dialog>');
    await loadScript();
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    document.getElementById("d")?.removeAttribute("open");
    await tick();
    expect(content()).toBe("new");
  });

  it("skips while a menu is open, even one in the top bar outside main", async () => {
    document.body.innerHTML = `<header class="app"><details class="menu" id="m" open><summary>More</summary></details></header>${PAGE("")}`;
    await loadScript();
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    document.getElementById("m")?.removeAttribute("open");
    await tick();
    expect(content()).toBe("new");
  });
});

describe("the chart tooltip", () => {
  const CHART = `<svg class="chart"><circle id="mark" r="4"><title>facts, 10-01: 4</title></circle></svg>`;

  it("shows the title text of the mark on pointerover and hides it on pointerout", async () => {
    document.body.innerHTML = PAGE(CHART, false);
    await loadScript();
    const mark = document.getElementById("mark");
    mark?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, clientX: 10, clientY: 10 }));
    const tip = document.querySelector("div.tooltip");
    expect(tip?.textContent).toBe("facts, 10-01: 4");
    expect(tip?.hasAttribute("hidden")).toBe(false);
    mark?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    expect(tip?.hasAttribute("hidden")).toBe(true);
    // The title goes back on the mark, so it keeps its accessible name.
    expect(mark?.querySelector("title")?.textContent).toBe("facts, 10-01: 4");
  });

  it("shows the lines of a slot hit rect as a multi-line tooltip", async () => {
    document.body.innerHTML = PAGE(
      `<svg class="chart"><g class="slot"><rect class="hit" id="hit"><title>10-01\nfacts: 4\ntags: –</title></rect></g></svg>`,
      false,
    );
    await loadScript();
    document.getElementById("hit")?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(document.querySelector("div.tooltip")?.textContent).toBe("10-01\nfacts: 4\ntags: –");
  });

  it("shows the definition of a label on pointerover and on focus, holds its title meanwhile and hides it on pointerout and blur", async () => {
    document.body.innerHTML = PAGE(
      `<span id="label" tabindex="0" data-definition="How many." title="How many.">Count</span>`,
      false,
    );
    await loadScript();
    const label = document.getElementById("label");
    label?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, clientX: 10, clientY: 10 }));
    const tip = document.querySelector("div.tooltip");
    expect(tip?.textContent).toBe("How many.");
    expect(tip?.hasAttribute("hidden")).toBe(false);
    expect(label?.hasAttribute("title")).toBe(false);
    label?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    expect(tip?.hasAttribute("hidden")).toBe(true);
    expect(label?.getAttribute("title")).toBe("How many.");
    label?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(tip?.textContent).toBe("How many.");
    expect(tip?.hasAttribute("hidden")).toBe(false);
    label?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(tip?.hasAttribute("hidden")).toBe(true);
    expect(label?.getAttribute("title")).toBe("How many.");
  });

  it("shows nothing for an element that is not a chart mark", async () => {
    document.body.innerHTML = PAGE("", false);
    await loadScript();
    document.getElementById("content")?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(document.querySelector("div.tooltip")).toBeNull();
  });
});

describe("the / key", () => {
  const press = (target: Element): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };

  it("focuses the search field", async () => {
    document.body.innerHTML = PAGE("", false);
    await loadScript();
    const e = press(document.body);
    expect(document.activeElement?.id).toBe("search");
    expect(e.defaultPrevented).toBe(true);
  });

  it("does nothing while the focus is in a field", async () => {
    document.body.innerHTML = PAGE('<textarea id="note"></textarea>', false);
    await loadScript();
    const note = document.getElementById("note") as HTMLTextAreaElement;
    note.focus();
    const e = press(note);
    expect(document.activeElement?.id).toBe("note");
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("Escape in the search box", () => {
  const escape = (target: Element): void => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  };

  it("clears the text first and blurs the box when it is already empty", async () => {
    document.body.innerHTML = PAGE("", false);
    await loadScript();
    const box = document.getElementById("search") as HTMLInputElement;
    box.focus();
    box.value = "creeper";
    escape(box);
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
    escape(box);
    expect(document.activeElement).not.toBe(box);
  });
});

describe("auto-apply", () => {
  const FORM = `<form data-auto id="f" method="get">
    <select id="tag" name="tag"><option value="">any</option><option value="a">a</option></select>
    <input type="checkbox" id="box" name="unread" value="1" />
    <input type="text" id="text" name="q" />
  </form>`;

  it("submits the form when a select or a checkbox changes, and not for a text field", async () => {
    document.body.innerHTML = PAGE(FORM, false);
    await loadScript();
    const form = document.getElementById("f") as HTMLFormElement;
    const submit = vi.fn();
    form.requestSubmit = submit;
    document.getElementById("tag")?.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("box")?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(2);
    document.getElementById("text")?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe("menus", () => {
  const MENUS = `<details class="menu" id="a"><summary id="sa">A</summary><div class="menu-list"><a href="#">x</a></div></details>
    <details class="menu" id="b"><summary id="sb">B</summary><div class="menu-list"><a href="#">y</a></div></details>`;
  const isOpen = (id: string): boolean => (document.getElementById(id) as HTMLDetailsElement).open;

  it("closes on an outside click but not on a click inside", async () => {
    document.body.innerHTML = PAGE(MENUS, false);
    await loadScript();
    (document.getElementById("a") as HTMLDetailsElement).open = true;
    document.querySelector("#a a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen("a")).toBe(true);
    document.getElementById("content")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen("a")).toBe(false);
  });

  it("closes on Escape and returns the focus to the summary", async () => {
    document.body.innerHTML = PAGE(MENUS, false);
    await loadScript();
    (document.getElementById("a") as HTMLDetailsElement).open = true;
    document.querySelector<HTMLElement>("#a a")?.focus();
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOpen("a")).toBe(false);
    expect(document.activeElement?.id).toBe("sa");
  });

  it("keeps one menu open: a click on the summary of another closes the first", async () => {
    document.body.innerHTML = PAGE(MENUS, false);
    await loadScript();
    (document.getElementById("a") as HTMLDetailsElement).open = true;
    document.getElementById("sb")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(isOpen("a")).toBe(false);
  });
});

describe("dialogs", () => {
  const DIALOG = `<button id="open" data-dialog="d">Correct</button>
    <dialog class="sheet" id="d"><form class="action"><input id="first" /></form></dialog>`;
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });

  beforeEach(() => {
    showModal.mockClear();
    // jsdom has no showModal.
    HTMLDialogElement.prototype.showModal = showModal;
  });

  it("opens the dialog of the button as a modal", async () => {
    document.body.innerHTML = PAGE(DIALOG, false);
    await loadScript();
    document.getElementById("open")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(document.getElementById("d")?.hasAttribute("open")).toBe(true);
  });

  it("returns the focus to the button when the dialog closes", async () => {
    document.body.innerHTML = PAGE(DIALOG, false);
    await loadScript();
    document.getElementById("first")?.focus();
    document.getElementById("d")?.dispatchEvent(new Event("close"));
    expect(document.activeElement?.id).toBe("open");
  });
});
