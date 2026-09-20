/**
 * Shared SSE framer. Protocol codecs own event semantics; this only splits
 * `event:` / `data:` lines into discrete events.
 */
export function createSseFramer(onEvent: (event: { event?: string; data: string }) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";
  let currentEvent: string | undefined;
  const dataLines: string[] = [];

  const emit = () => {
    if (dataLines.length === 0 && currentEvent === undefined) return;
    const data = dataLines.join("\n");
    onEvent({ event: currentEvent, data });
    currentEvent = undefined;
    dataLines.length = 0;
  };

  const consumeLine = (line: string) => {
    if (line === "") {
      emit();
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    },
    flush() {
      if (buffer) {
        consumeLine(buffer);
        buffer = "";
      }
      emit();
    },
  };
}
