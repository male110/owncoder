import { describe, expect, it } from "vitest";
import { mergeIncomingHistory } from "./useChatActions";

describe("mergeIncomingHistory", () => {
  it("replaces an optimistic user turn when the persisted turn has an id", () => {
    const merged = mergeIncomingHistory(
      [{ role: "user", content: "hello" }],
      [
        { role: "user", id: "turn-1", content: "hello" },
        { role: "assistant", id: "reply-1", content: "world" },
      ],
    );

    expect(merged).toEqual([
      { role: "user", id: "turn-1", content: "hello" },
      { role: "assistant", id: "reply-1", content: "world" },
    ]);
  });

  it("does not duplicate a committed reply already present in local history", () => {
    const reply = { role: "assistant" as const, id: "reply-1", content: "world" };
    const merged = mergeIncomingHistory(
      [
        { role: "user", content: "hello" },
        reply,
      ],
      [
        { role: "user", id: "turn-1", content: "hello" },
        { role: "assistant", id: "reply-1", content: "world" },
      ],
    );

    expect(merged).toEqual([
      { role: "user", id: "turn-1", content: "hello" },
      reply,
    ]);
  });
});
