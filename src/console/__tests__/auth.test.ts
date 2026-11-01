import { describe, expect, it } from "vitest";
import { Mode } from "../../domain/enums.js";
import { originRefusal, writesAllowed } from "../auth.js";

describe("originRefusal", () => {
  const service = { host: "127.0.0.1", port: 4321 };

  it("refuses a Sec-Fetch-Site of cross-site", () => {
    expect(originRefusal(service, { "sec-fetch-site": "cross-site" })).toBeDefined();
  });

  it("passes the other Sec-Fetch-Site values", () => {
    for (const value of ["same-origin", "same-site", "none"]) {
      expect(originRefusal(service, { "sec-fetch-site": value })).toBeUndefined();
    }
  });

  it("refuses an Origin with another host", () => {
    expect(originRefusal(service, { origin: "http://evil.example:4321" })).toBeDefined();
  });

  it("refuses an Origin with another port", () => {
    expect(originRefusal(service, { origin: "http://127.0.0.1:9999" })).toBeDefined();
    expect(originRefusal(service, { origin: "http://127.0.0.1" })).toBeDefined();
  });

  it("refuses an opaque Origin", () => {
    expect(originRefusal(service, { origin: "null" })).toBeDefined();
  });

  it("passes the Origin of the service, also under another loopback name", () => {
    expect(originRefusal(service, { origin: "http://127.0.0.1:4321" })).toBeUndefined();
    expect(originRefusal(service, { origin: "http://localhost:4321" })).toBeUndefined();
  });

  it("passes a request with neither header", () => {
    expect(originRefusal(service, {})).toBeUndefined();
  });
});

describe("writesAllowed", () => {
  it("allows local mode on the loopback addresses", () => {
    expect(writesAllowed({ mode: Mode.Local, host: "127.0.0.1" })).toBe(true);
    expect(writesAllowed({ mode: Mode.Local, host: "localhost" })).toBe(true);
  });
});
