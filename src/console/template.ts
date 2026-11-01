// Path templates of the console: `:name` segments bind a parameter. No router library: a few dozen fixed routes and no
// middleware are under 20 lines of plain logic (code-standard section 5).

/**
 * Compares a path with a template segment by segment.
 *
 * @param template - the path with `:name` for a parameter segment
 * @param path - the request path without the query
 * @returns the bound parameters (percent-escapes left as they are), or `undefined` when the path does not match; a
 *   `:name` segment binds a non-empty segment only
 * @sideEffects none
 */
export function matchTemplate(template: string, path: string): Record<string, string> | undefined {
  const want = template.split("/");
  const have = path.split("/");
  if (want.length !== have.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? "";
    const h = have[i] ?? "";
    if (w.startsWith(":") && h !== "") params[w.slice(1)] = h;
    else if (w !== h) return undefined;
  }
  return params;
}

/**
 * Fills a template with values.
 *
 * @param template - the path with `:name` for a parameter segment
 * @param params - the value of each parameter; it is percent-escaped
 * @returns the path
 * @sideEffects none
 */
export function fillTemplate(template: string, params: Record<string, string>): string {
  return template
    .split("/")
    .map((seg) => (seg.startsWith(":") ? encodeURIComponent(params[seg.slice(1)] ?? "") : seg))
    .join("/");
}
