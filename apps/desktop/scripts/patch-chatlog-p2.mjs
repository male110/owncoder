import fs from "fs";

const p = "apps/desktop/src/renderer/src/components/ChatLog.tsx";
let s = fs.readFileSync(p, "utf8");

s = s.replace(
  'import { useMemo, useState, useEffect, useRef, useCallback } from "react";',
  'import { useMemo, useState, useEffect, useRef, useCallback, memo } from "react";',
);

if (!s.includes("chat-log-model")) {
  s = s.replace(
    'import type { DecompositionSnapshot, LiveEvent, PendingTool } from "../store/chat-store";',
    `import type { DecompositionSnapshot, LiveEvent, PendingTool } from "../store/chat-store";
import {
  buildChatItems,
  buildLogBlocks,
  deriveLiveStatus,
  lastAssistantBlockIndex,
  toolLabel,
  toolStatusLabel,
  type ChatItem,
  type LogBlock,
} from "./chat-log-model";

export { toolStatusLabel } from "./chat-log-model";`,
  );
}

const start = s.indexOf("// ── Tool label helpers");
const end = s.indexOf("// ── Arg summary for tool cards");
if (start < 0 || end < 0) throw new Error(`label helpers markers missing ${start} ${end}`);
s = s.slice(0, start) + s.slice(end);

s = s.replace("function ToolCard({ turn }", "function ToolCardImpl({ turn }");
s = s.replace("function LiveToolCard({ tool }", "function LiveToolCardImpl({ tool }");
s = s.replace("function UserBubble({ turn }", "function UserBubbleImpl({ turn }");
s = s.replace("function AssistantBubble({", "function AssistantBubbleImpl({");
s = s.replace(
  "function ThinkingBlock({ content, streaming }",
  "function ThinkingBlockImpl({ content, streaming }",
);

const wrappers = `
const ToolCard = memo(ToolCardImpl, (prev, next) =>
  prev.turn === next.turn ||
  (prev.turn.id === next.turn.id &&
    prev.turn.content === next.turn.content &&
    prev.turn.toolName === next.turn.toolName &&
    prev.turn.isCompressed === next.turn.isCompressed &&
    prev.turn.originalLength === next.turn.originalLength)
);

const LiveToolCard = memo(LiveToolCardImpl, (prev, next) =>
  prev.tool === next.tool ||
  (prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.output === next.tool.output &&
    prev.tool.name === next.tool.name)
);

const UserBubble = memo(UserBubbleImpl, (prev, next) =>
  prev.turn === next.turn ||
  (prev.turn.id === next.turn.id &&
    prev.turn.content === next.turn.content &&
    prev.turn.isCompressed === next.turn.isCompressed &&
    prev.turn.originalLength === next.turn.originalLength)
);

const ThinkingBlock = memo(ThinkingBlockImpl, (prev, next) =>
  prev.content === next.content && prev.streaming === next.streaming
);

const AssistantBubble = memo(AssistantBubbleImpl, (prev, next) =>
  (prev.turn === next.turn ||
    (prev.turn.id === next.turn.id &&
      prev.turn.content === next.turn.content &&
      prev.turn.isCompressed === next.turn.isCompressed &&
      prev.turn.originalLength === next.turn.originalLength)) &&
  prev.canRegenerate === next.canRegenerate &&
  prev.regenerating === next.regenerating &&
  prev.onRegenerate === next.onRegenerate &&
  prev.onOpenFile === next.onOpenFile
);

`;

const chatLogMarker = "// ── ChatLog ─";
const idx = s.indexOf(chatLogMarker);
if (idx < 0) throw new Error("ChatLog marker missing");
s = s.slice(0, idx) + wrappers + s.slice(idx);

s = s.replace(/type LogBlock =[\s\S]*?;\r?\n\r?\ntype ChatItem =[\s\S]*?;\r?\n\r?\n/, "");

const oldBlocksStart = s.indexOf("  const blocks = useMemo(() => {");
const oldBlocksEnd = s.indexOf("  const lastAssistantIdx = useMemo(() => {");
if (oldBlocksStart < 0 || oldBlocksEnd < 0) throw new Error("blocks markers");
s =
  s.slice(0, oldBlocksStart) +
  `  const blocks = useMemo(
    () => buildLogBlocks(turns, sending, liveEvents.length),
    [turns, sending, liveEvents.length],
  );

` +
  s.slice(oldBlocksEnd);

const oldLastStart = s.indexOf("  const lastAssistantIdx = useMemo(() => {");
const oldLastEnd = s.indexOf("  // Derive a concise status label");
if (oldLastStart < 0 || oldLastEnd < 0) throw new Error("lastAssistant markers");
s =
  s.slice(0, oldLastStart) +
  `  const lastAssistantIdx = useMemo(() => lastAssistantBlockIndex(blocks), [blocks]);

` +
  s.slice(oldLastEnd);

const oldDerivedStart = s.indexOf("  // Derive a concise status label");
const oldDerivedEnd = s.indexOf("  // Decomposition cards belong");
if (oldDerivedStart < 0 || oldDerivedEnd < 0) throw new Error("derived markers");
s =
  s.slice(0, oldDerivedStart) +
  `  const derivedStatus = useMemo(
    () => deriveLiveStatus(sending, liveStatus, liveEvents),
    [sending, liveStatus, liveEvents],
  );

` +
  s.slice(oldDerivedEnd);

const oldItemsStart = s.indexOf("  const items = useMemo<ChatItem[]>(() => {");
const oldItemsEnd = s.indexOf("  // 仅挂载时生效");
if (oldItemsStart < 0 || oldItemsEnd < 0) throw new Error("items markers");
s =
  s.slice(0, oldItemsStart) +
  `  const items = useMemo(
    () =>
      buildChatItems(
        blocks,
        derivedStatus,
        sending,
        decompositionCards.length,
        nonDecomposeLiveEvents.length,
      ),
    [blocks, derivedStatus, sending, decompositionCards.length, nonDecomposeLiveEvents.length],
  );

` +
  s.slice(oldItemsEnd);

s = s.replace(
  `  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={\`msg user \${isCompressed ? "compressed" : ""}\`}>`,
  `  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={\`msg user \${isCompressed ? "compressed" : ""}\`}>`,
);

s = s.replace(
  `  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={\`msg assistant \${isCompressed ? "compressed" : ""}\`}>`,
  `  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className={\`msg assistant \${isCompressed ? "compressed" : ""}\`}>`,
);

s = s.replace(
  `  useEffect(() => {
    if (open && streaming && bodyRef.current) {
      requestAnimationFrame(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); });
    }
  }, [content, open, streaming]);`,
  `  const scrollFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (open && streaming && bodyRef.current) {
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
      });
    }
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [content, open, streaming]);`,
);

s = s.replace(
  `  useEffect(() => {
    if (open && tool.output && bodyRef.current) {
      requestAnimationFrame(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); });
    }
  }, [tool.output, open]);`,
  `  const scrollFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (open && tool.output && bodyRef.current) {
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
      });
    }
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [tool.output, open]);`,
);

fs.writeFileSync(p, s);
console.log("patched ChatLog, lines", s.split(/\n/).length);
for (const needle of [
  "buildLogBlocks",
  "ToolCard = memo",
  "UserBubble = memo",
  "AssistantBubble = memo",
  "export { toolStatusLabel }",
  "type LogBlock =",
  "function toolStatusLabel",
  "function toolLabel",
]) {
  console.log(needle, s.includes(needle));
}
