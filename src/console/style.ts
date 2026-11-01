// The one style sheet of the console (technical/console.md, "Architecture" and "Visual design and interaction"), served at `/console/style.css`. A string constant,
// so `tsc` is the whole build. One sheet by concern: tokens, base, shell, text, parts, forms, tables, charts, dialogs
// (technical/console.md, "Principles", V1). Every color is a token (V2); the dark values sit under `prefers-color-scheme: dark`. No external font,
// script or style.

/** The path the style sheet is served at. */
export const STYLE_PATH = "/console/style.css";

/** The style sheet text. */
export const STYLE_SHEET = `
/* Tokens (technical/console.md, "Tokens") */
:root {
  color-scheme: light dark;
  --page: #f6f6f4;
  --surface: #ffffff;
  --surface-2: #efeeeb;
  --ink: #161614;
  --ink-2: #5c5b57;
  --muted: #8e8d87;
  --line: #e4e3dd;
  --line-2: #c9c8c0;
  --accent: #2563eb;
  --accent-wash: rgba(37, 99, 235, 0.1);
  --on-accent: #ffffff;
  --good: #15803d;
  --warn: #b45309;
  --bad: #b91c1c;
  --good-wash: rgba(21, 128, 61, 0.12);
  --warn-wash: rgba(180, 83, 9, 0.12);
  --bad-wash: rgba(185, 28, 28, 0.12);
  --s0: #2563eb;
  --s1: #ea580c;
  --s2: #0f9f6e;
  --s3: #ca8a04;
  --shade: rgba(0, 0, 0, 0.35);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, Consolas, "Cascadia Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #111110;
    --surface: #1b1b1a;
    --surface-2: #262624;
    --ink: #f0efec;
    --ink-2: #b8b7ae;
    --muted: #7f7e78;
    --line: #2d2d2b;
    --line-2: #3d3d3a;
    --accent: #5b8def;
    --accent-wash: rgba(91, 141, 239, 0.16);
    --good: #34c26a;
    --warn: #f2a93b;
    --bad: #f06c6c;
    --good-wash: rgba(52, 194, 106, 0.2);
    --warn-wash: rgba(242, 169, 59, 0.2);
    --bad-wash: rgba(240, 108, 108, 0.2);
    --s0: #5b8def;
    --s1: #f97316;
    --s2: #2fbf87;
    --s3: #eab308;
    --shade: rgba(0, 0, 0, 0.6);
  }
}

/* Base (technical/console.md, "Principles", V5, V10) */
* { box-sizing: border-box; }
html { scrollbar-gutter: stable; }
html, body { margin: 0; padding: 0; }
body {
  min-height: 100vh;
  font: 15px/1.5 var(--font);
  color: var(--ink);
  background: var(--page);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { font-weight: 600; line-height: 1.3; }
h3 { margin: 16px 0 8px; font-size: 15px; }
code { font-family: var(--mono); font-size: 13px; }
code { background: var(--surface-2); padding: 0 4px; border-radius: 4px; }
.muted { color: var(--muted); }
.error { color: var(--bad); }
time { white-space: nowrap; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Shell (technical/console.md, "Shell" and "The shell"): the top bar, the page header, the grid */
header.app {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 52px;
  padding: 0 max(32px, calc((100% - 1200px) / 2 + 32px));
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
a.brand { font-size: 15px; font-weight: 600; color: var(--ink); }
a.brand:hover { text-decoration: none; }
nav.tabs { display: flex; align-self: stretch; gap: 16px; }
nav.tabs a {
  display: flex;
  align-items: center;
  padding: 0 4px;
  font-weight: 500;
  color: var(--ink-2);
}
nav.tabs a:hover { color: var(--ink); text-decoration: none; }
nav.tabs a[aria-current="page"] { color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
header.app div.end { display: flex; align-items: center; gap: 12px; margin-left: auto; }
header.app div.end p.muted { margin: 0; font-size: 14px; }
a.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 12px;
  font-size: 14px;
  color: var(--ink);
  background: var(--surface-2);
  border-radius: 999px;
  white-space: nowrap;
}
a.status:hover { text-decoration: none; box-shadow: 0 0 0 1px var(--line-2); }
a.status .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--muted); }
a.status.green { background: var(--good-wash); }
a.status.green .dot { background: var(--good); }
a.status.yellow { background: var(--warn-wash); }
a.status.yellow .dot { background: var(--warn); }
a.status.red { background: var(--bad-wash); }
a.status.red .dot { background: var(--bad); }
details.menu { position: relative; }
details.menu > summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-weight: 500;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  list-style: none;
  cursor: pointer;
}
details.menu > summary::-webkit-details-marker { display: none; }
details.menu > summary::after {
  content: "";
  width: 6px;
  height: 6px;
  margin-top: -3px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}
details.menu > summary:hover, details.menu[open] > summary { background: var(--surface-2); }
div.menu-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 200px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
details.menu.more div.menu-list { left: auto; right: 0; }
div.menu-list a { display: block; padding: 6px 12px; color: var(--ink); border-radius: 4px; }
div.menu-list a:hover { background: var(--surface-2); text-decoration: none; }
div.menu-list a[aria-current] { font-weight: 600; background: var(--accent-wash); }
div.menu-list hr { margin: 4px 0; border: 0; border-top: 1px solid var(--line); }
div.menu-list p.muted { margin: 0; padding: 6px 12px; font-size: 14px; }
main { max-width: 1200px; margin: 0 auto; padding: 0 32px 48px; }
header.page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 16px;
  align-items: center;
  margin: 24px 0 20px;
}
header.page h1 { grid-column: 1; margin: 0; font-size: 20px; }
header.page p.lead { grid-column: 1; margin: 4px 0 0; color: var(--ink-2); }
header.page div.controls {
  grid-column: 2;
  grid-row: 1 / span 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
section.plain { margin-top: 32px; }
section.plain > h2 { margin: 0 0 12px; font-size: 16px; }
h2 .aside { margin-left: 12px; }
div.grid { display: grid; gap: 16px; margin: 16px 0; }
div.grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
div.grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
div.grid.cols-2-1 { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
div.grid.cols-main-side { grid-template-columns: minmax(0, 1fr) 320px; }
div.grid > .span-all { grid-column: 1 / -1; }
div.col { display: grid; gap: 16px; align-content: start; min-width: 0; }
div.col > div.grid, div.panel-body div.grid { margin: 0; }
div.panel-body div.grid { align-items: start; }
@media (max-width: 899px) {
  header.app { flex-wrap: wrap; height: auto; min-height: 52px; gap: 8px 16px; padding: 8px 16px; }
  nav.tabs { order: 3; flex-basis: 100%; overflow-x: auto; }
  nav.tabs a { padding: 8px 4px; }
  main { padding: 0 16px 48px; }
  header.page { grid-template-columns: minmax(0, 1fr); }
  header.page div.controls { grid-column: 1; grid-row: auto; justify-content: flex-start; margin-top: 12px; }
  div.grid.cols-2, div.grid.cols-3, div.grid.cols-2-1, div.grid.cols-main-side { grid-template-columns: minmax(0, 1fr); }
}

/* Text (technical/console.md, "Parts": stat row, panel, empty state, key-value list, quote, notice) */
.l { display: block; font-size: 14px; font-weight: 400; color: var(--ink-2); }
div.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, 240px);
  justify-content: start;
  gap: 16px 32px;
  margin: 0;
}
/* A half-width panel (a cell of cols-2) holds 3 stats across: a narrower stat that may shrink. A full-width panel keeps 240 px. */
@media (min-width: 900px) {
  div.grid.cols-2 > section.panel:not(.span-all) div.stats,
  div.grid.cols-2 > div.col > section.panel div.stats,
  div.grid.cols-2 > div.subsection div.stats { grid-template-columns: repeat(3, minmax(0, 150px)); gap: 16px 24px; }
}
.stat { display: block; min-width: 0; color: var(--ink); }
a.stat:hover { text-decoration: none; background: var(--surface-2); }
.stat .n { display: block; font-size: 28px; font-weight: 600; line-height: 1.3; }
.stat .n[data-definition] { width: fit-content; max-width: 100%; cursor: help; }
.stat .n.ok { color: var(--good); }
.stat .n.warning { color: var(--warn); }
.stat .n.failing { color: var(--bad); }
.stat .u .ok { color: var(--good); }
.stat .u .warning { color: var(--warn); }
.stat .u .failing { color: var(--bad); }
p.help .warning { color: var(--warn); }
.stat .u { display: block; font-size: 14px; color: var(--muted); }
div.subsection { min-width: 0; }
div.subsection > p.note { margin-bottom: 8px; }
div.groups { display: grid; gap: 16px; margin-bottom: 16px; }figure.plot { min-width: 0; margin: 0; }
figure.plot > .l { margin-bottom: 8px; }
.defined { text-decoration: underline dotted var(--line-2); text-decoration-thickness: 1px; text-underline-offset: 3px; cursor: help; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
section.panel {
  min-width: 0;
  margin: 0;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
header.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
header.panel-head h2 { margin: 0; font-size: 16px; }
p.note { margin: 0; font-size: 14px; color: var(--ink-2); }
.aside { font-size: 14px; font-weight: 400; color: var(--ink-2); }
/* An aside adds no height and never wraps onto its own line: the title and the note shrink instead (technical/console.md, "Parts", the Panel row). */
header.panel-head { flex-wrap: nowrap; }
header.panel-head > h2, header.panel-head > p.note { min-width: 0; }
header.panel-head .aside { flex: none; display: flex; align-items: center; align-self: center; height: 0; margin-left: auto; gap: 8px; }
div.panel-body { min-width: 0; }
p.empty { margin: 0; color: var(--muted); }
p.count { margin: 0 0 8px; font-size: 14px; color: var(--ink-2); }
dl.kv { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 6px 16px; margin: 0; }
dl.kv + h3 { margin-top: 24px; }
section.form-section > h3 { margin: 0 0 12px; }
section.form-section + section.form-section { margin-top: 24px; }
dl.kv dt { font-size: 14px; color: var(--ink-2); }
dl.kv dd { margin: 0; overflow-wrap: anywhere; }
dl.kv dd code { overflow-wrap: anywhere; }
p.label { margin: 0 0 4px; font-size: 14px; color: var(--ink-2); }
blockquote.quote + p.label { margin-top: 12px; }
div.panel-body > details.fold { margin-top: 12px; }
blockquote.quote {
  margin: 0;
  padding-left: 12px;
  font-size: 16px;
  color: var(--ink);
  border-left: 3px solid var(--accent);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
p.notice { margin: 12px 0; padding: 8px 12px; background: var(--accent-wash); border-left: 4px solid var(--accent); border-radius: 0 6px 6px 0; }
p.notice.bad { background: var(--bad-wash); border-left-color: var(--bad); }

/* Parts (technical/console.md, "Parts": segmented control, toolbar, paging, lists, badge, marker, chip, meter, fold, diff, tooltip) */
nav.segmented { display: inline-flex; padding: 2px; background: var(--surface-2); border-radius: 6px; }
nav.segmented a { padding: 4px 10px; font-size: 14px; font-weight: 500; color: var(--ink-2); border-radius: 4px; }
nav.segmented a:hover { color: var(--ink); text-decoration: none; }
nav.segmented a[aria-current] { color: var(--ink); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
form.toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin: 0 0 12px; }
form.toolbar details.more { flex-basis: 100%; }
form.toolbar details.more > summary { font-size: 14px; color: var(--ink-2); cursor: pointer; }
form.toolbar div.more-fields { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin-top: 8px; }
ul.applied { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; padding: 0; list-style: none; }
a.chip { display: inline-block; margin: 2px 4px 2px 0; padding: 0 8px; font-size: 13px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; white-space: nowrap; }
a.chip:hover { border-color: var(--accent); text-decoration: none; }
ul.applied a.chip { margin: 0; }
nav.paging { margin: 12px 0; text-align: right; }
a.button { display: inline-block; padding: 6px 12px; font-weight: 500; color: var(--ink); background: var(--surface); border: 1px solid var(--line-2); border-radius: 6px; }
a.button:hover { background: var(--surface-2); text-decoration: none; }
ol.results { max-width: 760px; margin: 0; padding: 0; list-style: none; }
li.result { padding: 16px 0; }
li.result + li.result { border-top: 1px solid var(--line); }
li.result h3 { margin: 0 0 4px; font-size: 16px; overflow-wrap: anywhere; }
li.result p.content { margin: 0 0 8px; font-size: 16px; overflow-wrap: anywhere; }
li.result div.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 14px; }
ol.timeline { margin: 0; padding: 0; list-style: none; border-left: 2px solid var(--line); }
li.entry { position: relative; padding: 0 0 20px 20px; }
li.entry::before { content: ""; position: absolute; top: 4px; left: -6px; width: 10px; height: 10px; border-radius: 999px; background: var(--line-2); }
li.entry[aria-current]::before { background: var(--accent); }
li.entry div.when { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 14px; }
li.entry p.what { margin: 4px 0 0; overflow-wrap: anywhere; }
ul.interps { display: grid; gap: 8px; margin: 16px 0 0; padding: 12px 0 0; list-style: none; border-top: 1px solid var(--line); }
p.reading { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; align-items: baseline; margin: 0; font-size: 14px; color: var(--ink-2); }
ul.interps.flush { margin: 0; padding: 0; border-top: 0; }
ul.interps.under { margin: 12px 0 0; padding: 0; border-top: 0; }
p.reading svg.info { align-self: center; color: var(--ink-2); }
p.reading.yellow, p.reading.yellow svg.info { color: var(--warn); }
p.reading.red, p.reading.red svg.info { color: var(--bad); }
.badge { display: inline-flex; align-items: center; gap: 8px; padding: 0 10px; font-size: 14px; font-weight: 400; color: var(--ink); background: var(--surface-2); border-radius: 999px; vertical-align: middle; }
.badge::before { content: ""; width: 8px; height: 8px; border-radius: 999px; background: var(--muted); }
.badge:hover { text-decoration: none; }
.badge.green { background: var(--good-wash); }
.badge.green::before { background: var(--good); }
.badge.yellow { background: var(--warn-wash); }
.badge.yellow::before { background: var(--warn); }
.badge.red { background: var(--bad-wash); }
.badge.red::before { background: var(--bad); }
.marker { display: inline-block; margin-left: 4px; padding: 0 8px; font-size: 13px; font-weight: 400; color: var(--ink); background: var(--bad-wash); border-radius: 999px; vertical-align: middle; }
.marker.live, .marker.observed, .marker.done { background: var(--good-wash); }
.marker.derived, .marker.queued { background: var(--surface-2); }
span.meter { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.meter meter { appearance: none; width: 72px; height: 6px; background: var(--line); border: 0; border-radius: 999px; vertical-align: middle; overflow: hidden; }
.meter meter::-webkit-meter-bar { height: 6px; background: var(--line); border: 0; border-radius: 999px; }
.meter meter::-webkit-meter-optimum-value, .meter meter::-webkit-meter-suboptimum-value, .meter meter::-webkit-meter-even-less-good-value { background: var(--accent); border-radius: 999px; }
.meter meter::-moz-meter-bar { background: var(--accent); border-radius: 999px; }
details.fold > summary { font-size: 14px; color: var(--ink-2); list-style: none; cursor: pointer; }
details.fold > summary::-webkit-details-marker { display: none; }
details.fold > summary::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  margin: 0 8px 2px 2px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
}
details.fold[open] > summary::before { transform: rotate(45deg); }
details.fold[open] > summary { margin-bottom: 8px; }
ins { background: var(--good-wash); text-decoration: none; }
del { background: var(--bad-wash); text-decoration: line-through; }
div.tooltip {
  position: fixed;
  z-index: 50;
  max-width: 360px;
  padding: 6px 8px;
  font-size: 13px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  white-space: pre-line;
  pointer-events: none;
}
div.tooltip[hidden] { display: none; }

/* Forms (technical/console.md, "Parts") */
label.field { display: flex; flex-direction: column; gap: 2px; font-size: 14px; color: var(--ink-2); }
label.field:has(> input[type="checkbox"]) { flex-direction: row; align-items: center; gap: 6px; }
label.field.choice { display: grid; grid-template-columns: auto 1fr; align-items: baseline; column-gap: 6px; row-gap: 2px; }
label.field.choice > .help { grid-column: 2; }
input, select, textarea {
  font: inherit;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 6px 10px;
}
input::placeholder, textarea::placeholder { color: var(--muted); }
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
input[type="checkbox"], input[type="radio"] { padding: 0; accent-color: var(--accent); }
input.search {
  width: 100%;
  padding: 10px 12px 10px 40px;
  font-size: 18px;
  background-image:
    radial-gradient(circle closest-side, transparent 3.6px, var(--muted) 4px, var(--muted) 5.4px, transparent 5.8px),
    linear-gradient(135deg, transparent 42%, var(--muted) 42%, var(--muted) 58%, transparent 58%);
  background-repeat: no-repeat;
  background-size: 12px 12px, 6px 6px;
  background-position: 14px center, 22px calc(50% + 5px);
}
button {
  font: inherit;
  font-weight: 500;
  padding: 6px 12px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
button:hover { background: var(--surface-2); }
button.primary { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
button.primary:hover { background: var(--accent); opacity: 0.9; }
button.danger { color: var(--bad); border-color: var(--bad); }
button.danger:hover { background: var(--bad-wash); }
p.help, .help { margin: 4px 0; font-size: 14px; color: var(--ink-2); }
label.field .help { margin: 0; }
form.action { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; margin: 0; }
form.action label.field { width: 100%; }
form.action textarea { width: 100%; min-height: calc(4 * 1.5em + 12px); }
form.action input[type="text"], form.action select { width: 100%; }
form.action input, form.action textarea, form.action select { max-width: 640px; }
dialog.sheet form.action input, dialog.sheet form.action textarea, dialog.sheet form.action select { max-width: none; }
div.search-row { display: flex; gap: 8px; align-items: stretch; }
div.search-row input.search { flex: 1 1 auto; width: auto; min-width: 0; }
div.search-row button { flex: none; }
div.search-options { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 8px; font-size: 14px; }
pre.text { margin: 0; padding: 12px; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
td form.action { flex-direction: row; align-items: center; }

/* Tables (technical/console.md, "Parts") */
div.scroll { max-width: 100%; max-height: 70vh; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th {
  position: sticky;
  top: 0;
  padding: 8px 12px;
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  color: var(--ink-2);
  background: var(--surface-2);
  white-space: nowrap;
}
th a { color: var(--ink-2); }
th a.sorted { color: var(--ink); }
th a.sorted::after { content: " \\25BC"; font-size: 10px; }
td { padding: 11px 12px; vertical-align: top; border-bottom: 1px solid var(--line); }
tbody tr:hover { background: var(--surface-2); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.key { min-width: 16em; }
td.wide { max-width: 26em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
th.act, td.act { width: 96px; text-align: right; white-space: nowrap; }
td.act { padding-top: 5px; padding-bottom: 5px; }
main > div.scroll { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
td code { overflow-wrap: anywhere; }
td button, td a.button, header.panel-head .aside button { padding: 4px 10px; font-size: 14px; }
td .subject { display: block; max-width: 32em; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td form { display: inline; margin: 0; }

/* Charts (technical/console.md, "Charts") */
svg.chart { display: block; width: 100%; height: auto; font-family: inherit; }
svg.chart text { fill: var(--ink); }
svg.chart .axis line { stroke: var(--line-2); stroke-width: 1; }
svg.chart .axis line.grid { stroke: var(--line); }
svg.chart .axis text { fill: var(--muted); }
svg.chart .s0 { --c: var(--s0); }
svg.chart .s1 { --c: var(--s1); }
svg.chart .s2 { --c: var(--s2); }
svg.chart .s3 { --c: var(--s3); }
svg.chart .line { fill: none; stroke: var(--c); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg.chart .point { fill: var(--c); stroke: var(--surface); stroke-width: 2; }
svg.chart .bar, svg.chart .swatch { fill: var(--c); }
svg.chart .legend text { fill: var(--ink-2); }
svg.chart g.axis-title text { fill: var(--ink-2); }
svg.chart g.reference line { stroke: var(--line-2); stroke-width: 1; }
svg.chart g.reference text { fill: var(--ink-2); }
svg.chart g.clipped path { fill: var(--c); }
svg.chart g.clipped text { fill: var(--ink); font-weight: 600; paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
svg.chart g.slot line.cursor { stroke: var(--line-2); stroke-width: 1; opacity: 0; pointer-events: none; }
svg.chart g.slot:hover line.cursor { opacity: 1; }
svg.chart g.slot rect.hit { fill: transparent; }

/* Dialogs (technical/console.md, "Parts", V8) */
dialog.sheet {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 24px;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
dialog.sheet::backdrop { background: var(--shade); }
dialog.sheet h2 { margin: 0; font-size: 16px; }
dialog.sheet form.action { align-items: stretch; }
div.buttons { display: flex; justify-content: flex-end; gap: 8px; }
`;
