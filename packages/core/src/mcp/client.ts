/**
 * Minimal stdio MCP client (JSON-RPC 2.0) for tools/list + tools/call.
 * Spec subset: initialize → tools/list → tools/call.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpServerConfig {
  /** Unique id in settings */
  id: string;
  /** Display name */
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpToolDef {
  serverId: string;
  name: string;
  /** Full tool name exposed to the LLM: mcp__{serverId}__{name} */
  qualifiedName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

type JsonRpcId = number;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class McpStdioClient {
  readonly config: McpServerConfig;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private tools: McpToolDef[] = [];
  private ready = false;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  get isReady(): boolean {
    return this.ready;
  }

  getToolDefs(): McpToolDef[] {
    return this.tools;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const env = { ...process.env, ...this.config.env };
    this.proc = spawn(this.config.command, this.config.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => {
      /* ignore noisy stderr */
    });
    this.proc.on("exit", () => {
      this.ready = false;
      this.proc = null;
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP server exited: ${this.config.id}`));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "owncoder", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    await this.refreshTools();
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.kill();
  }

  async refreshTools(): Promise<McpToolDef[]> {
    const result = (await this.request("tools/list", {})) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>;
    };
    const sid = this.config.id;
    this.tools = (result.tools ?? []).map((t) => ({
      serverId: sid,
      name: t.name,
      qualifiedName: `mcp__${sid}__${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const texts = (result.content ?? [])
      .filter((c) => c.type === "text" || c.text)
      .map((c) => c.text ?? "")
      .join("\n");
    if (result.isError) {
      throw new Error(texts || "MCP tool error");
    }
    return texts || "(empty MCP result)";
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  private write(msg: unknown): void {
    if (!this.proc?.stdin.writable) throw new Error("MCP stdin closed");
    const body = JSON.stringify(msg);
    // Content-Length framing (MCP stdio)
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        // Some servers send newline-delimited JSON without Content-Length
        const nl = this.buf.indexOf("\n");
        if (nl < 0) return;
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line.startsWith("{")) this.handleMessage(line);
        continue;
      }
      const header = this.buf.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.slice(start, start + len);
      this.buf = this.buf.slice(start + len);
      this.handleMessage(body);
    }
  }

  private handleMessage(raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
    };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
      else p.resolve(msg.result);
    }
  }
}

export class McpManager {
  private clients = new Map<string, McpStdioClient>();

  async sync(servers: McpServerConfig[]): Promise<void> {
    const enabled = servers.filter((s) => s.enabled !== false && s.command?.trim());
    const ids = new Set(enabled.map((s) => s.id));

    for (const [id, c] of this.clients) {
      if (!ids.has(id)) {
        await c.stop();
        this.clients.delete(id);
      }
    }

    for (const cfg of enabled) {
      let client = this.clients.get(cfg.id);
      if (!client) {
        client = new McpStdioClient(cfg);
        this.clients.set(cfg.id, client);
        try {
          await client.start();
        } catch (e) {
          await client.stop().catch(() => undefined);
          this.clients.delete(cfg.id);
          console.error(`[mcp] failed to start ${cfg.id}:`, e);
        }
      }
    }
  }

  listTools(): McpToolDef[] {
    const out: McpToolDef[] = [];
    for (const c of this.clients.values()) {
      if (c.isReady) out.push(...c.getToolDefs());
    }
    return out;
  }

  async call(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const m = /^mcp__([^_]+)__(.+)$/.exec(qualifiedName) || /^mcp__([^_]+)_(.+)$/.exec(qualifiedName);
    // Format: mcp__{serverId}__{toolName} — serverId may contain underscores; use split after mcp__
    const rest = qualifiedName.startsWith("mcp__") ? qualifiedName.slice(5) : "";
    const sep = rest.indexOf("__");
    if (sep < 0) throw new Error(`Invalid MCP tool name: ${qualifiedName}`);
    const serverId = rest.slice(0, sep);
    const toolName = rest.slice(sep + 2);
    void m;
    const client = this.clients.get(serverId);
    if (!client?.isReady) throw new Error(`MCP server not ready: ${serverId}`);
    return client.callTool(toolName, args);
  }

  async stopAll(): Promise<void> {
    for (const c of this.clients.values()) await c.stop();
    this.clients.clear();
  }
}

/** Convert MCP tools to OpenAI tool definitions. */
export function mcpToolsToOpenAi(
  tools: McpToolDef[],
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.qualifiedName,
      description: t.description || `MCP tool ${t.name} from ${t.serverId}`,
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}
