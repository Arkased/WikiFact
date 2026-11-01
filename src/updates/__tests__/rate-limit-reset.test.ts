import { describe, expect, it } from "vitest";
import { RATE_LIMIT_RESET_MAX_MS, rateLimitResetAt } from "../worker-status.js";

const LA = "America/Los_Angeles";
const text = (reset: string): string =>
  `rate limited: stop_reason stop_sequence, 1 turns, subtype success, result You've hit your session limit · resets ${reset}  \n{"duration_api_ms":0`;
const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());

// 05:00 in Los Angeles (PDT, UTC-7).
const MORNING = Date.parse("2026-10-19T12:00:00Z");

describe('rate limit reset time (technical/updates.md, "Failure modes", F26)', () => {
  it("reads each form that the service log holds", () => {
    expect(iso(rateLimitResetAt(text(`4pm (${LA})`), MORNING))).toBe("2026-10-19T23:00:00.000Z");
    expect(iso(rateLimitResetAt(text(`6:10pm (${LA})`), MORNING))).toBe("2026-10-20T01:10:00.000Z");
    expect(iso(rateLimitResetAt(text(`11:30pm (${LA})`), MORNING))).toBe("2026-10-20T06:30:00.000Z");
    expect(iso(rateLimitResetAt(text(`Oct 19, 4pm (${LA})`), MORNING))).toBe("2026-10-19T23:00:00.000Z");
    expect(iso(rateLimitResetAt(text(`Oct 20, 6:10pm (${LA})`), MORNING))).toBe("2026-10-21T01:10:00.000Z");
  });

  it("reads am and the noon and midnight hours", () => {
    expect(iso(rateLimitResetAt(text(`9am (${LA})`), MORNING))).toBe("2026-10-19T16:00:00.000Z");
    expect(iso(rateLimitResetAt(text(`12pm (${LA})`), MORNING))).toBe("2026-10-19T19:00:00.000Z");
    expect(iso(rateLimitResetAt(text(`12am (${LA})`), MORNING))).toBe("2026-10-20T07:00:00.000Z");
  });

  it("takes a time with no date that has passed today as the same time tomorrow", () => {
    const afternoon = Date.parse("2026-10-19T23:30:00Z"); // 16:30 in Los Angeles
    expect(iso(rateLimitResetAt(text(`4pm (${LA})`), afternoon))).toBe("2026-10-20T23:00:00.000Z");
  });

  it("uses the date of the zone, which can differ from the date in UTC", () => {
    // 03:00 UTC on Oct 19 is 20:00 on Oct 18 in Los Angeles: the next 4pm there is still on Oct 18 (23:00 UTC).
    const now = Date.parse("2026-10-19T03:00:00Z");
    expect(iso(rateLimitResetAt(text(`4pm (${LA})`), now))).toBe("2026-10-19T23:00:00.000Z");
    // 12:00 on Oct 19 in Tokyo: the next 1am there is on Oct 20 (16:00 UTC on Oct 19).
    expect(iso(rateLimitResetAt(text("1am (Asia/Tokyo)"), now))).toBe("2026-10-19T16:00:00.000Z");
  });

  it("carries the day over the end of a month and a year", () => {
    const now = Date.parse("2026-12-31T23:00:00Z"); // 15:00 in Los Angeles
    expect(iso(rateLimitResetAt(text(`2pm (${LA})`), now))).toBe("2027-01-01T22:00:00.000Z");
  });

  it("follows the daylight saving change of the zone", () => {
    // The change in Los Angeles was at 09:00 UTC on Nov 1; 4pm that day is UTC-8.
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(iso(rateLimitResetAt(text(`4pm (${LA})`), now))).toBe("2026-11-02T00:00:00.000Z");
  });

  it("reads a date with no year as the next year when it is long past", () => {
    const now = Date.parse("2026-12-30T12:00:00Z");
    expect(iso(rateLimitResetAt(text(`Jan 2, 9am (${LA})`), now))).toBe("2027-01-02T17:00:00.000Z");
  });

  it("gives nothing for a time that has passed", () => {
    expect(rateLimitResetAt(text(`Oct 18, 4pm (${LA})`), MORNING)).toBeUndefined();
    expect(rateLimitResetAt(text(`Oct 19, 4am (${LA})`), MORNING)).toBeUndefined();
  });

  it("takes a time at the ceiling and gives nothing for one minute over it", () => {
    // Reset texts in UTC, 12-hour clock with minutes, built from the ceiling.
    const utcText = (ms: number): string => {
      const d = new Date(ms);
      const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      const hour = d.getUTCHours() % 12 === 0 ? 12 : d.getUTCHours() % 12;
      const minute = String(d.getUTCMinutes()).padStart(2, "0");
      return text(`${month} ${d.getUTCDate()}, ${hour}:${minute}${d.getUTCHours() < 12 ? "am" : "pm"} (UTC)`);
    };
    expect(rateLimitResetAt(utcText(MORNING + RATE_LIMIT_RESET_MAX_MS), MORNING)).toBe(
      MORNING + RATE_LIMIT_RESET_MAX_MS,
    );
    expect(rateLimitResetAt(utcText(MORNING + RATE_LIMIT_RESET_MAX_MS + 60_000), MORNING)).toBeUndefined();
  });

  it("gives nothing for a text with no time, a bad clock, a bad month or an unknown zone", () => {
    expect(rateLimitResetAt("429 too many requests", MORNING)).toBeUndefined();
    expect(rateLimitResetAt("resets soon", MORNING)).toBeUndefined();
    expect(rateLimitResetAt(text(`13pm (${LA})`), MORNING)).toBeUndefined();
    expect(rateLimitResetAt(text(`Foo 19, 4pm (${LA})`), MORNING)).toBeUndefined();
    expect(rateLimitResetAt(text("4pm (Not/AZone)"), MORNING)).toBeUndefined();
  });
});
