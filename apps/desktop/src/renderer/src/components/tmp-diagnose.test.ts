import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildLogBlocks, buildChatItems } from "./chat-log-model";
import type { ChatTurnDto } from "../../../preload/index";

describe("diagnose real session", () => {
  it("blocks for active session", () => {
    const raw = JSON.parse(readFileSync("E:/owncoder/.owncoder/sessions/mu472ytp-0du8ta.json", "utf-8"));
    const h: any[] = raw.history;
    const turns = h.filter((t) => ["user", "assistant", "tool", "system"].includes(t.role)) as ChatTurnDto[];
    console.log("total turns:", turns.length);
    const blocks = buildLogBlocks(turns, false, 0);
    console.log("blocks:", blocks.map((b, i) => `${i}:${b.kind}${b.kind === "user" ? " len=" + (b as any).turn.content.length : b.kind === "assistant" ? " len=" + (b as any).turn.content.length : " items=" + (b as any).items.length}`));
    const items = buildChatItems(blocks);
    console.log("items:", items.length, "first key:", items[0]?.key, "last:", items[items.length - 1]?.key);
  });
});
