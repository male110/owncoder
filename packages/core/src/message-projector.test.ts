import { describe, it, expect } from "vitest";
import { MessageProjector } from "./message-projector";

describe("MessageProjector streaming snapshot semantics", () => {
  it("does not duplicate cumulative thinking snapshots (was O(n^2))", () => {
    const p = new MessageProjector();
    const chunks = 3000;
    let snapshot = "";
    for (let i = 0; i < chunks; i++) {
      snapshot += "思考片段。";
      p.handleEvent({ type: "thinking_delta", sessionId: "s1", text: snapshot });
    }
    p.handleEvent({ type: "assistant_delta", sessionId: "s1", text: "最终回复" });
    const { parts } = p.finalize();
    const thinking = parts.find((part) => part.type === "thinking");
    expect(thinking?.type).toBe("thinking");
    expect(thinking?.text).toBe("思考片段。".repeat(chunks));
    expect(parts.find((part) => part.type === "text")?.text).toBe("最终回复");
  });

  it("keeps one text part when assistant_delta delivers cumulative snapshots", () => {
    const p = new MessageProjector();
    let snapshot = "";
    for (let i = 0; i < 2000; i++) {
      snapshot += "ab";
      p.handleEvent({ type: "assistant_delta", sessionId: "s1", text: snapshot });
    }
    const { parts } = p.finalize();
    const textParts = parts.filter((part) => part.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe("ab".repeat(2000));
  });

  it("still appends one-shot reports emitted after the stream", () => {
    const p = new MessageProjector();
    let snapshot = "";
    for (let i = 0; i < 100; i++) {
      snapshot += "x";
      p.handleEvent({ type: "assistant_delta", sessionId: "s1", text: snapshot });
    }
    p.handleEvent({ type: "assistant_delta", sessionId: "s1", text: "最终报告正文" });
    const { parts } = p.finalize();
    const textParts = parts.filter((part) => part.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toBe("x".repeat(100) + "最终报告正文");
  });
});
