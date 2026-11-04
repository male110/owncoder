import { describe, expect, it } from "vitest";
import { completionMenuPosition } from "./TerminalCompletionMenu";

const anchor = { left: 200, top: 100, lineHeight: 16, width: 700, height: 280 };

describe("completionMenuPosition", () => {
  it("opens below the cursor when there is space", () => {
    expect(completionMenuPosition(anchor)).toMatchObject({ left: 200, top: 118, above: false });
  });

  it("opens above prompts near the bottom", () => {
    expect(completionMenuPosition({ ...anchor, top: 250 })).toMatchObject({
      top: 32, above: true, maxHeight: 234,
    });
  });

  it("clamps right-edge and narrow-screen menus to the terminal", () => {
    expect(completionMenuPosition({ ...anchor, left: 690 }).left).toBe(336);
    expect(completionMenuPosition({ ...anchor, width: 220 })).toMatchObject({ left: 4, maxWidth: 212 });
  });

  it("reports insufficient room so both rendering and key interception can be disabled", () => {
    expect(completionMenuPosition({ ...anchor, height: 30, top: 10 }).maxHeight).toBeLessThan(36);
  });
});
