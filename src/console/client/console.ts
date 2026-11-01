// The browser script of the console (technical/console.md, "Interactions"): 6 behaviors (refresh in place, chart tooltip, search key,
// auto-apply, menu, dialog), each keyed by a data attribute or a part class the server renders and delegated on the
// document, so a page works without it except the automatic refresh and the dialogs. It imports nothing, reads only the
// DOM, stores nothing, and inserts the server's HTML only, never a string built from a value. `tsc` compiles it with
// `tsconfig.client.json`; it is a classic script (no `export`), loaded with `defer`.

/** The main area that asks for a refresh, with the number of seconds in `data-refresh`. */
const REFRESH_SELECTOR = "main[data-refresh]";
/** The fields whose focus or edit holds a refresh back. */
const FIELD_SELECTOR = "input, select, textarea";
/** A dialog that is open: the refresh waits, because it would close what the person is writing. */
const OPEN_DIALOG_SELECTOR = "dialog[open]";
/** A menu that is open: the refresh waits. */
const OPEN_MENU_SELECTOR = "details.menu[open]";
/** The button that opens the dialog whose id is in `data-dialog`. */
const DIALOG_BUTTON_SELECTOR = "button[data-dialog]";
/** A form that submits itself on a change of a select or a checkbox. */
const AUTO_FORM_SELECTOR = "form[data-auto]";
/** A chart mark carries its value in a child `<title>`. */
const TITLE_SELECTOR = ":scope > title";
/** A label that carries the definition of a signal in `data-definition`. */
const DEFINITION_SELECTOR = "[data-definition]";
const DEFINITION_ATTRIBUTE = "data-definition";
/** The search field of a page. */
const SEARCH_SELECTOR = "[data-search]";
/** Milliseconds in a second. */
const MS_PER_SECOND = 1000;
/** How far the tooltip sits from the cursor, in px. */
const TOOLTIP_OFFSET = 12;
/** The gap between a focused label and its tooltip, in px. */
const TOOLTIP_GAP_PX = 4;

let refreshTimer: number | undefined;

/**
 * Tells whether an element is a form field that a person types in.
 *
 * @param el - any element or null
 * @returns true for an input, a select, a text area or an editable element
 * @sideEffects none
 */
function isField(el: Element | null): boolean {
  return el !== null && (el.matches(FIELD_SELECTOR) || (el instanceof HTMLElement && el.isContentEditable));
}

/**
 * Tells whether a field holds something the person changed.
 *
 * @param field - an input, a select or a text area
 * @returns true when its value or state differs from the default the server rendered
 * @sideEffects none
 */
function isDirty(field: Element): boolean {
  if (field instanceof HTMLSelectElement)
    return Array.from(field.options).some((o) => o.selected !== o.defaultSelected);
  if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio"))
    return field.checked !== field.defaultChecked;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
    return field.value !== field.defaultValue;
  return false;
}

/**
 * Tells whether a refresh would lose what the person is doing in `main`.
 *
 * @param main - the main area
 * @returns true while a field in it has the focus or holds an edited value, a dialog is open, or a menu is open
 * @sideEffects none
 */
function isBusy(main: Element): boolean {
  const active = document.activeElement;
  if (active !== null && main.contains(active) && isField(active)) return true;
  if (main.querySelector(OPEN_DIALOG_SELECTOR) !== null) return true;
  if (document.querySelector(OPEN_MENU_SELECTOR) !== null) return true;
  return Array.from(main.querySelectorAll(FIELD_SELECTOR)).some(isDirty);
}

/**
 * Fetches the current page and swaps the content of `main` for the one the server sends.
 *
 * @param main - the main area to refresh
 * @returns nothing; a failed fetch leaves the page as it is
 * @sideEffects one GET of the page URL; replaces `main.innerHTML`; copies or removes `data-refresh`; keeps the scroll
 */
async function refreshMain(main: Element): Promise<void> {
  const res = await fetch(location.href, { credentials: "same-origin" });
  if (!res.ok) return;
  const next = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("main");
  // A field may have gained the focus while the fetch ran.
  if (next === null || isBusy(main)) return;
  const { scrollX, scrollY } = window;
  main.innerHTML = next.innerHTML;
  const seconds = next.getAttribute("data-refresh");
  if (seconds === null) main.removeAttribute("data-refresh");
  else main.setAttribute("data-refresh", seconds);
  window.scrollTo(scrollX, scrollY);
}

/**
 * Plans the next refresh from the `data-refresh` of the page, and does nothing when the page has none.
 *
 * @sideEffects clears and sets the refresh timer
 */
function scheduleRefresh(): void {
  window.clearTimeout(refreshTimer);
  const main = document.querySelector(REFRESH_SELECTOR);
  const seconds = Number(main?.getAttribute("data-refresh"));
  if (main === null || !(seconds > 0)) return;
  refreshTimer = window.setTimeout(() => {
    const target = document.querySelector(REFRESH_SELECTOR);
    const run = target === null || isBusy(target) ? Promise.resolve() : refreshMain(target).catch(() => undefined);
    void run.then(scheduleRefresh);
  }, seconds * MS_PER_SECOND);
}

/** The element under the cursor or focus whose title is held back while the tooltip shows its text. */
interface Hover {
  mark: Element;
  /** Puts the held title back on the element. */
  restore: () => void;
  text: string;
}

let hover: Hover | undefined;
let tooltip: HTMLDivElement | undefined;

/**
 * Gives the one tooltip element, creating it on first use.
 *
 * @returns the `div.tooltip` appended to `body`
 * @sideEffects appends the element to `body` on the first call
 */
function tooltipElement(): HTMLDivElement {
  if (tooltip === undefined) {
    tooltip = document.createElement("div");
    tooltip.className = "tooltip";
    tooltip.hidden = true;
    document.body.append(tooltip);
  }
  return tooltip;
}

/**
 * Hides the tooltip and puts the held `<title>` back on its mark, so the mark keeps its accessible name.
 *
 * @sideEffects hides the tooltip; re-attaches the title element
 */
function releaseMark(): void {
  hover?.restore();
  hover = undefined;
  if (tooltip !== undefined) tooltip.hidden = true;
}

/**
 * Shows the tooltip for the chart mark under the cursor, or hides it when there is none. The browser's own tooltip
 * would show the same text a second time, so the `<title>` is held off the mark while the cursor is on it.
 *
 * @param e - the mouse event
 * @sideEffects moves the title element of the mark; shows, fills and moves the tooltip
 */
function onPointerMove(e: MouseEvent): void {
  const target = e.target instanceof Element ? e.target : null;
  if (hover !== undefined && target !== hover.mark) releaseMark();
  if (hover === undefined && target !== null) {
    const definition = target.closest(DEFINITION_SELECTOR);
    if (definition !== null) holdDefinition(definition);
    else if (target.closest("svg.chart") !== null) {
      const title = target.querySelector(TITLE_SELECTOR);
      if (title !== null) hover = { mark: target, restore: () => target.append(title), text: title.textContent ?? "" };
      title?.remove();
    }
  }
  if (hover === undefined) return;
  showTooltip(hover.text, e.clientX, e.clientY);
}

/**
 * Fills the one tooltip, shows it at a point and keeps it inside the window.
 *
 * @param text - the text to show
 * @param x - the point, in px from the left of the window
 * @param y - the point, in px from the top of the window
 * @sideEffects shows, fills and moves the tooltip
 */
function showTooltip(text: string, x: number, y: number): void {
  const box = tooltipElement();
  box.textContent = text;
  box.hidden = false;
  const flip = x + TOOLTIP_OFFSET + box.offsetWidth > window.innerWidth;
  box.style.left = `${flip ? Math.max(0, x - TOOLTIP_OFFSET - box.offsetWidth) : x + TOOLTIP_OFFSET}px`;
  box.style.top = `${y + TOOLTIP_OFFSET}px`;
}

/**
 * Holds the `title` off a definition label while the tooltip shows the same text.
 *
 * @param el - the element with `data-definition`
 * @sideEffects removes the `title` attribute of the element; sets `hover`
 */
function holdDefinition(el: Element): void {
  const text = el.getAttribute(DEFINITION_ATTRIBUTE) ?? "";
  el.removeAttribute("title");
  hover = { mark: el, restore: () => el.setAttribute("title", text), text };
}

/**
 * Shows the definition of a label that takes the focus, under the label.
 *
 * @param e - the focus event
 * @sideEffects holds the title of the label; shows the tooltip
 */
function onFocusIn(e: FocusEvent): void {
  const el = e.target instanceof Element ? e.target.closest(DEFINITION_SELECTOR) : null;
  if (el === null) return;
  releaseMark();
  holdDefinition(el);
  const rect = el.getBoundingClientRect();
  showTooltip(hover?.text ?? "", rect.left, rect.bottom - TOOLTIP_OFFSET + TOOLTIP_GAP_PX);
}

/**
 * Hides the tooltip of a definition when its label loses the focus.
 *
 * @param e - the focus event
 * @sideEffects hides the tooltip; puts the title back
 */
function onFocusOut(e: FocusEvent): void {
  if (e.target === hover?.mark) releaseMark();
}

/**
 * Hides the tooltip when the cursor leaves the window.
 *
 * @param e - the mouse event
 * @sideEffects hides the tooltip; re-attaches the held title element
 */
function onPointerOut(e: MouseEvent): void {
  if (e.relatedTarget === null) releaseMark();
}

/**
 * Lists the menus that are open.
 *
 * @returns the open `details.menu` elements
 * @sideEffects none
 */
function openMenus(): HTMLDetailsElement[] {
  return Array.from(document.querySelectorAll(OPEN_MENU_SELECTOR)).filter(
    (el): el is HTMLDetailsElement => el instanceof HTMLDetailsElement,
  );
}

/**
 * Handles Escape: in the search box it clears the text, or blurs the box when it is empty; elsewhere it closes the open
 * menus and returns the focus to the summary of the first.
 *
 * @param e - the key event
 * @sideEffects edits or blurs the search box; closes menus; focuses a summary; cancels the key when it acted
 */
function onEscape(e: KeyboardEvent): void {
  const target = e.target;
  if (target instanceof HTMLInputElement && target.matches(SEARCH_SELECTOR)) {
    e.preventDefault();
    if (target.value === "") target.blur();
    else target.value = "";
    return;
  }
  const menus = openMenus();
  menus.forEach((m) => {
    m.open = false;
  });
  menus[0]?.querySelector("summary")?.focus();
}

/**
 * Focuses the search field when `/` is typed outside a field, and handles Escape.
 *
 * @param e - the key event
 * @sideEffects focuses and selects the field marked `data-search`; cancels the key
 */
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    onEscape(e);
    return;
  }
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isField(document.activeElement)) return;
  const field = document.querySelector(SEARCH_SELECTOR);
  if (!(field instanceof HTMLInputElement)) return;
  e.preventDefault();
  field.focus();
  field.select();
}

/**
 * Submits a `form[data-auto]` when a select or a checkbox in it changes.
 *
 * @param e - the change event
 * @sideEffects submits the form through `requestSubmit`, which runs its validation and submit event
 */
function onChange(e: Event): void {
  const target = e.target;
  const isChoice =
    target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === "checkbox");
  if (!isChoice) return;
  const form = target.closest(AUTO_FORM_SELECTOR);
  if (form instanceof HTMLFormElement) form.requestSubmit();
}

/**
 * Handles a click: a dialog button opens its dialog; a click outside the open menus closes them, so one menu is open
 * at a time (a click on another menu's summary is outside the first).
 *
 * @param e - the click event
 * @sideEffects opens a dialog as a modal; closes menus
 */
function onClick(e: MouseEvent): void {
  const target = e.target instanceof Element ? e.target : null;
  const button = target?.closest(DIALOG_BUTTON_SELECTOR);
  if (button !== null && button !== undefined) {
    const dialog = document.getElementById(button.getAttribute("data-dialog") ?? "");
    if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
    return;
  }
  openMenus().forEach((m) => {
    if (target === null || !m.contains(target)) m.open = false;
  });
}

/**
 * Returns the focus to the button that opened a dialog when the dialog closes. The `close` event does not bubble, so
 * the listener is on the capture phase.
 *
 * @param e - the close event
 * @sideEffects focuses the button of the dialog
 */
function onDialogClose(e: Event): void {
  const dialog = e.target;
  if (!(dialog instanceof HTMLDialogElement)) return;
  const button = Array.from(document.querySelectorAll(DIALOG_BUTTON_SELECTOR)).find(
    (b) => b.getAttribute("data-dialog") === dialog.id,
  );
  if (button instanceof HTMLElement) button.focus();
}

// Delegation on the document, so a refresh of `main` needs no rebinding.
document.addEventListener("pointerover", onPointerMove);
document.addEventListener("pointermove", onPointerMove);
document.addEventListener("pointerout", onPointerOut);
document.addEventListener("focusin", onFocusIn);
document.addEventListener("focusout", onFocusOut);
document.addEventListener("keydown", onKeyDown);
document.addEventListener("change", onChange);
document.addEventListener("click", onClick);
document.addEventListener("close", onDialogClose, true);
scheduleRefresh();
