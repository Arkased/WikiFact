import { afterEach, describe, expect, it } from "vitest";
import { LogEvent, LogLevel, RouteKind } from "../../domain/enums.js";
import type { LogLine } from "../../log/index.js";
import { firstRoute, mcpTarget, startHttpServer, type HttpHandle, type Route } from "../http.js";
import { createServer } from "../server.js";
import { McpSessions } from "../sessions.js";

describe("firstRoute", () => {
  it("answers with the first route that knows the path, and undefined when none does", () => {
    const a = mcpTarget(
      () => createServer({ dbPath: "", config: {} as never, writeStore: {} as never }),
      new McpSessions({ log: () => undefined }),
    );
    const b = { kind: RouteKind.Http, handle: () => Promise.resolve() } as const;
    const route = firstRoute([(p) => (p === "/a" ? a : undefined), (p) => (p === "/a" || p === "/b" ? b : undefined)]);
    expect(route("/a")).toBe(a);
    expect(route("/b")).toBe(b);
    expect(route("/c")).toBeUndefined();
    expect(firstRoute([])("/a")).toBeUndefined();
  });
});

describe("startHttpServer with a plain handler", () => {
  let handle: HttpHandle | undefined;
  const logs: LogLine[] = [];
  afterEach(async () => {
    if (handle) await new Promise((r) => handle?.server.close(r));
    handle = undefined;
    logs.length = 0;
  });

  it("lets the handler pick the method and the status", async () => {
    const route: Route = (p) =>
      p === "/plain"
        ? {
            kind: RouteKind.Http,
            handle: (req, res) => {
              res.writeHead(202, { "X-Method": req.method ?? "" }).end("ok");
              return Promise.resolve();
            },
          }
        : undefined;
    handle = await startHttpServer(route, { host: "127.0.0.1", port: 0, log: (l) => logs.push(l) });
    const res = await fetch(`http://127.0.0.1:${handle.port}/plain`, { method: "PUT" });
    expect(res.status).toBe(202);
    expect(res.headers.get("x-method")).toBe("PUT");
    expect(await res.text()).toBe("ok");
    expect((await fetch(`http://127.0.0.1:${handle.port}/other`)).status).toBe(404);
  });

  it("answers 500 and logs an httpError when the handler throws", async () => {
    const route: Route = () => ({ kind: RouteKind.Http, handle: () => Promise.reject(new Error("boom")) });
    handle = await startHttpServer(route, { host: "127.0.0.1", port: 0, log: (l) => logs.push(l) });
    const res = await fetch(`http://127.0.0.1:${handle.port}/x`);
    expect(res.status).toBe(500);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: LogEvent.HttpError, level: LogLevel.Error, error: "Error: boom" }),
    );
  });
});
