import { constants } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { lowerPriorityOrThrow, type PriorityOs } from "../main.js";

const PID = 4242;
const READ_BACK = 10;

describe("lowerPriorityOrThrow", () => {
  it("sets below normal and returns the priority that it reads back", () => {
    const set = vi.fn<PriorityOs["set"]>();
    const get = vi.fn<PriorityOs["get"]>(() => READ_BACK);
    expect(lowerPriorityOrThrow(PID, { set, get })).toBe(READ_BACK);
    expect(set).toHaveBeenCalledExactlyOnceWith(PID, constants.priority.PRIORITY_BELOW_NORMAL);
    expect(get).toHaveBeenCalledExactlyOnceWith(PID);
  });

  it("throws when the os refuses the change, and reads nothing back", () => {
    const get = vi.fn<PriorityOs["get"]>(() => READ_BACK);
    const set = (): void => {
      throw new Error("access denied");
    };
    expect(() => lowerPriorityOrThrow(PID, { set, get })).toThrow("access denied");
    expect(get).not.toHaveBeenCalled();
  });
});
