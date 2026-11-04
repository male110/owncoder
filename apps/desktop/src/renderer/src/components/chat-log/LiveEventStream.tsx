import { memo } from "react";
import { Markdown } from "../Markdown";
import type { LiveEvent } from "../../store/chat-store";
import { ThinkingBlock } from "./ThinkingBlock";
import { LiveToolCard } from "./LiveToolCard";
import { SubagentGroupCard } from "./SubagentGroup";

// ── LiveEventStream: renders liveEvents[] in order ───────────────────────────

function LiveEventStreamImpl({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="live-event-stream">
      {events.map((ev) => {
        if (ev.kind === "thinking") {
          return (
            <ThinkingBlock
              key={ev.id}
              content={ev.text}
              streaming={ev.streaming}
              stage={ev.stage}
            />
          );
        }
        if (ev.kind === "subagent") {
          return <SubagentGroupCard key={`subagent-${ev.group.id}`} group={ev.group} />;
        }
        if (ev.kind === "tool") {
          return <LiveToolCard key={`tool-${ev.tool.id}`} tool={ev.tool} />;
        }
        // decompose events are rendered by ChatLog inside the current-turn
        // assistant container, before the live event stream; skip here.
        if (ev.kind === "decompose") return null;
        // text (must narrow the union — ev may be "structured" which has no .text)
        if (ev.kind !== "text") return null;
        if (!ev.text) return null;
        return (
          <div key={ev.id} className={`msg assistant${ev.streaming ? " streaming" : ""}`}>
            <Markdown content={ev.text} />
            {ev.streaming ? <span className="stream-cursor" /> : null}
          </div>
        );
      })}
    </div>
  );
}

export const LiveEventStream = memo(LiveEventStreamImpl, (prev, next) => prev.events === next.events);
