import { spawn, type ChildProcess } from "node:child_process";
import upath from "upath";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────

export interface LspClientConfig {
  /** Language server command (e.g., "typescript-language-server") */
  command: string;
  /** Arguments to pass to the server */
  args?: string[];
  /** Working directory for the server */
  cwd?: string;
  /** Initialization options */
  initOptions?: Record<string, unknown>;
  /** File types this server handles */
  fileTypes: string[];
}

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

export interface LspHover {
  contents: { kind: "markdown" | "plaintext"; value: string };
  range?: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: 1 | 2 | 3 | 4; // Error, Warning, Info, Hint
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspSymbolInformation {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

// ── LSP Client ─────────────────────────────────────────────

export class LspClient {
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, (result: unknown) => void>();
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private buffer = "";
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private openDocuments = new Map<string, string>(); // uri → content
  private rootUri: string;
  private readonly config: LspClientConfig;

  constructor(config: LspClientConfig) {
    this.config = config;
    this.rootUri = `file://${path.resolve(config.cwd ?? process.cwd())}`;
  }

  // ── Lifecycle ────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize();
    return this.initPromise;
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.initialized = false;
    this.initPromise = null;
  }

  private async initialize(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.process = spawn(this.config.command, this.config.args ?? [], {
          cwd: this.config.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
      } catch (e) {
        reject(new Error(`Failed to spawn LSP server: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }

      if (!this.process) {
        reject(new Error("LSP process is null"));
        return;
      }

      this.process.stdout?.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        this.processMessages();
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        // Log stderr but don't treat as error
        console.debug(`[LSP stderr] ${data.toString().trim()}`);
      });

      this.process.on("error", (err) => {
        reject(new Error(`LSP process error: ${err.message}`));
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`LSP server exited with code ${code}`));
        }
        this.initialized = false;
      });

      // Send initialize request
      const initRequest = {
        jsonrpc: "2.0" as const,
        id: this.nextId(),
        method: "initialize",
        params: {
          processId: process.pid,
          capabilities: {
            textDocument: {
              synchronization: {
                willSave: true,
                willSaveWaitUntil: true,
                didSave: true,
              },
              completion: {
                dynamicRegistration: true,
              },
              hover: {
                dynamicRegistration: true,
                contentFormat: ["markdown", "plaintext"],
              },
              definition: {
                dynamicRegistration: true,
              },
              references: {
                dynamicRegistration: true,
              },
              documentSymbol: {
                dynamicRegistration: true,
                hierarchicalDocumentSymbolSupport: true,
              },
              diagnostic: {
                dynamicRegistration: true,
              },
            },
            workspace: {
              workspaceFolders: [
                {
                  uri: this.rootUri,
                  name: path.basename(this.rootUri),
                },
              ],
            },
            rootUri: this.rootUri,
            initializationOptions: this.config.initOptions ?? {},
          },
        },
      };

      this.sendRequest(initRequest).then(() => {
        // Send initialized notification
        this.sendNotification({
          jsonrpc: "2.0",
          method: "initialized",
          params: {},
        });
        this.initialized = true;
        resolve();
      }).catch(reject);
    });
  }

  private nextId(): number {
    return ++this.messageId;
  }

  private sendRequest(request: {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params: unknown;
  }): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("LSP process not started"));
        return;
      }

      const id = request.id;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${request.method}`));
      }, 30_000);

      this.pendingRequests.set(id, (result: unknown) => {
        clearTimeout(timer);
        resolve(result);
      });

      this.sendMessage(request);
    });
  }

  private sendNotification(notification: {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
  }): void {
    if (!this.process?.stdin) return;
    this.sendMessage(notification);
  }

  private sendMessage(message: object): void {
    if (!this.process?.stdin) return;
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
    this.process.stdin.write(header + json);
  }

  private processMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1]!, 10);
      const totalMessageLength = headerEnd + 4 + contentLength;

      if (this.buffer.length < totalMessageLength) break;

      const messageContent = this.buffer.slice(headerEnd + 4, totalMessageLength);
      this.buffer = this.buffer.slice(totalMessageLength);

      try {
        const message = JSON.parse(messageContent);
        this.handleMessage(message);
      } catch {
        console.warn("[LSP] Failed to parse message:", messageContent.slice(0, 200));
      }
    }
  }

  private handleMessage(message: {
    id?: number;
    method?: string;
    result?: unknown;
    params?: unknown;
    error?: { code: number; message: string };
  }): void {
    // Response to our request
    if (message.id !== undefined && message.result !== undefined) {
      const handler = this.pendingRequests.get(message.id);
      if (handler) {
        this.pendingRequests.delete(message.id);
        handler(message.result);
      }
      return;
    }

    // Error response
    if (message.id !== undefined && message.error) {
      const handler = this.pendingRequests.get(message.id);
      if (handler) {
        this.pendingRequests.delete(message.id);
        handler(null); // Resolve with null, caller checks for errors
      }
      return;
    }

    // Server-to-client notification
    if (message.method) {
      const handler = this.notificationHandlers.get(message.method);
      if (handler) {
        handler(message.params);
      }
    }
  }

  // ── Document Management ──────────────────────────────────

  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    await this.start();
    this.openDocuments.set(uri, text);
    this.sendNotification({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId, version: 1, text },
      },
    });
  }

  async changeDocument(uri: string, text: string, version: number): Promise<void> {
    await this.start();
    this.openDocuments.set(uri, text);
    this.sendNotification({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      },
    });
  }

  async closeDocument(uri: string): Promise<void> {
    this.openDocuments.delete(uri);
    this.sendNotification({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    });
  }

  // ── LSP Operations ───────────────────────────────────────

  async goToDefinition(
    uri: string,
    position: LspPosition,
  ): Promise<LspLocationLink[] | LspLocation[] | null> {
    await this.start();
    const result = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "textDocument/definition",
      params: { textDocument: { uri }, position },
    });
    if (!result) return null;
    const arr = result as (LspLocation | LspLocationLink) | (LspLocation[] | LspLocationLink[]);
    return (Array.isArray(arr) ? arr : [arr]) as LspLocationLink[] | LspLocation[];
  }

  async findReferences(
    uri: string,
    position: LspPosition,
    includeDeclaration = true,
  ): Promise<LspLocation[]> {
    await this.start();
    const result = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "textDocument/references",
      params: {
        textDocument: { uri },
        position,
        context: { includeDeclaration },
      },
    });
    return (result as LspLocation[]) ?? [];
  }

  async getHover(uri: string, position: LspPosition): Promise<LspHover | null> {
    await this.start();
    const result = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "textDocument/hover",
      params: { textDocument: { uri }, position },
    });
    return (result as LspHover) ?? null;
  }

  async getDocumentSymbols(uri: string): Promise<LspSymbolInformation[]> {
    await this.start();
    const result = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "textDocument/documentSymbol",
      params: { textDocument: { uri } },
    });
    if (!result) return [];
    // Handle hierarchical document symbols
    const symbols = result as Array<{
      name: string;
      kind: number;
      location: LspLocation;
      children?: unknown[];
    }>;
    const flat: LspSymbolInformation[] = [];
    const flatten = (arr: Array<{ name: string; kind: number; location: LspLocation; children?: unknown[] }>, container?: string) => {
      for (const sym of arr) {
        flat.push({ name: sym.name, kind: sym.kind, location: sym.location, containerName: container });
        if (sym.children) flatten(sym.children as Array<{ name: string; kind: number; location: LspLocation; children?: unknown[] }>, sym.name);
      }
    };
    flatten(symbols);
    return flat;
  }

  async getWorkspaceSymbols(query: string): Promise<LspSymbolInformation[]> {
    await this.start();
    const result = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "workspace/symbol",
      params: { query },
    });
    return (result as LspSymbolInformation[]) ?? [];
  }

  async getDiagnostics(uri: string): Promise<LspDiagnostic[]> {
    await this.start();
    // For diagnostics, we listen for publishDiagnostics notification
    return new Promise<LspDiagnostic[]>((resolve) => {
      const handler = (params: unknown) => {
        const dp = params as { uri: string; diagnostics: LspDiagnostic[] };
        if (dp.uri === uri) {
          this.notificationHandlers.delete("textDocument/publishDiagnostics");
          resolve(dp.diagnostics);
        }
      };
      this.notificationHandlers.set("textDocument/publishDiagnostics", handler);

      // Request diagnostics via didSave or by waiting for the server to push
      // Most servers push diagnostics automatically after open/change
      // Set a timeout for servers that don't push
      setTimeout(() => {
        this.notificationHandlers.delete("textDocument/publishDiagnostics");
        // Try a diagnostic request if the server supports it
        resolve([]);
      }, 5000);
    });
  }

  async getCodeActions(uri: string, range: LspRange): Promise<unknown[]> {
    await this.start();
    const diagnostics = await this.getDiagnostics(uri);
    const result = await this.sendRequest({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "textDocument/codeAction",
      params: {
        textDocument: { uri },
        range,
        context: {
          diagnostics,
          only: ["quickfix", "refactor"],
        },
      },
    });
    return (result as unknown[]) ?? [];
  }
}

// ── LSP Client Manager ────────────────────────────────────

export class LspClientManager {
  private clients = new Map<string, LspClient>();
  private fileTypeMap = new Map<string, string>(); // ext → server key
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** Register a language server for specific file types */
  registerServer(key: string, config: LspClientConfig): LspClient {
    const client = new LspClient({ ...config, cwd: this.cwd });
    this.clients.set(key, client);
    for (const ft of config.fileTypes) {
      this.fileTypeMap.set(ft, key);
    }
    return client;
  }

  /** Get or create a client for a file based on extension */
  getClientForFile(filePath: string): LspClient | null {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const serverKey = this.fileTypeMap.get(ext);
    if (!serverKey) return null;
    return this.clients.get(serverKey) ?? null;
  }

  /** Get client by key */
  getClient(key: string): LspClient | null {
    return this.clients.get(key) ?? null;
  }

  /** Start all registered servers */
  async startAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.start()));
  }

  /** Stop all registered servers */
  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }

  /** Open a document in the appropriate server */
  async openFile(filePath: string, content: string): Promise<void> {
    const client = this.getClientForFile(filePath);
    if (!client) return;
    const uri = this.pathToUri(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const languageId = this.extToLanguageId(ext);
    await client.openDocument(uri, languageId, content);
  }

  /** Convert file path to LSP URI */
  pathToUri(filePath: string): string {
    const absPath = path.resolve(this.cwd, filePath);
    return `file://${upath.normalize(absPath)}`;
  }

  /** Convert LSP URI to file path */
  uriToPath(uri: string): string {
    return uri.replace(/^file:\/\//, "").replace(/\//g, path.sep);
  }

  private extToLanguageId(ext: string): string {
    const map: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      html: "html",
      css: "css",
      scss: "scss",
      less: "less",
      json: "json",
      py: "python",
      rs: "rust",
      go: "go",
      java: "java",
      rb: "ruby",
      php: "php",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      md: "markdown",
      yaml: "yaml",
      yml: "yaml",
      toml: "toml",
    };
    return map[ext] ?? ext;
  }
}

// ── Default Server Configurations ─────────────────────────

const DEFAULT_SERVERS: Record<string, LspClientConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: ["ts", "tsx", "js", "jsx", "mts", "cts"],
  },
  html: {
    command: "vscode-html-language-server",
    args: ["--stdio"],
    fileTypes: ["html"],
  },
  css: {
    command: "vscode-css-language-server",
    args: ["--stdio"],
    fileTypes: ["css", "scss", "less"],
  },
  json: {
    command: "vscode-json-language-server",
    args: ["--stdio"],
    fileTypes: ["json"],
  },
  python: {
    command: "pylsp",
    args: [],
    fileTypes: ["py"],
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    fileTypes: ["rs"],
  },
};

/** Create a manager with default server configurations */
export function createDefaultLspManager(cwd: string): LspClientManager {
  const manager = new LspClientManager(cwd);
  for (const [key, config] of Object.entries(DEFAULT_SERVERS)) {
    manager.registerServer(key, config);
  }
  return manager;
}
