import { describe, expect, it } from "vitest";
import { isRailSegmentReached } from "./DecomposeCard";

describe("isRailSegmentReached", () => {
  it("marks only completed or skipped predecessor tasks as reached", () => {
    expect(isRailSegmentReached("completed")).toBe(true);
    expect(isRailSegmentReached("skipped")).toBe(true);
    expect(isRailSegmentReached("pending")).toBe(false);
    expect(isRailSegmentReached("in_progress")).toBe(false);
    expect(isRailSegmentReached("failed")).toBe(false);
    expect(isRailSegmentReached(null)).toBe(false);
  });

  it("does not infer a segment from aggregate completion count", () => {
    const statuses = ["pending", "completed", "in_progress"] as const;
    const segments = statuses.slice(0, -1).map(isRailSegmentReached);
    expect(segments).toEqual([false, true]);
  });
});
