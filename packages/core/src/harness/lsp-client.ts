import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { promisify } from "node:util";
import upath from "upath";
import path from "node:path";
import { runLspNpmInstall, lspNodeRuntime, resolveLspNodeEntry } from "./lsp-npm.ts";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────

export interface LspClientConfig {
  /** Language server command (e.g., "typescript-language-server") */
  command: string;
  /** Arguments to pass to the server */
  args?: string[];
  /** Working directory for the server */
  cwd?: string;
  /** 语言服务器子进程环境（用于应用内 Node 运行时）。 */
  env?: NodeJS.ProcessEnv;
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
  /** Latest diagnostics pushed by the server (uri → diagnostics). */
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
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
          env: this.config.env,
          windowsHide: true,
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
      if (message.method === "textDocument/publishDiagnostics") {
        const dp = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
        if (dp?.uri) {
          this.diagnosticsCache.set(dp.uri, Array.isArray(dp.diagnostics) ? dp.diagnostics : []);
        }
      }
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

    // Fast path: server already pushed diagnostics for this uri (e.g. after didOpen).
    const cached = this.diagnosticsCache.get(uri);
    if (cached) return cached;

    // Wait for the next publishDiagnostics for this uri (most servers push after open/change).
    return new Promise<LspDiagnostic[]>((resolve) => {
      const previous = this.notificationHandlers.get("textDocument/publishDiagnostics");
      const handler = (params: unknown) => {
        previous?.(params);
        const dp = params as { uri: string; diagnostics: LspDiagnostic[] };
        if (dp.uri === uri) {
          clearTimeout(timer);
          this.notificationHandlers.delete("textDocument/publishDiagnostics");
          if (previous) this.notificationHandlers.set("textDocument/publishDiagnostics", previous);
          resolve(dp.diagnostics ?? []);
        }
      };
      this.notificationHandlers.set("textDocument/publishDiagnostics", handler);

      const timer = setTimeout(() => {
        this.notificationHandlers.delete("textDocument/publishDiagnostics");
        if (previous) this.notificationHandlers.set("textDocument/publishDiagnostics", previous);
        resolve(this.diagnosticsCache.get(uri) ?? []);
      }, 5_000);
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

  /** Remove a registered server and its extension routes */
  unregisterServer(key: string): void {
    this.clients.delete(key);
    for (const [ext, serverKey] of [...this.fileTypeMap.entries()]) {
      if (serverKey === key) this.fileTypeMap.delete(ext);
    }
  }

  /** Get or create a client for a file based on extension */
  getClientForFile(filePath: string): LspClient | null {
    const baseName = path.basename(filePath).toLowerCase();
    if (baseName === "dockerfile") {
      const dockerServer = this.fileTypeMap.get("dockerfile");
      if (dockerServer) return this.clients.get(dockerServer) ?? null;
    }
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const serverKey = this.fileTypeMap.get(ext);
    if (!serverKey) return null;
    return this.clients.get(serverKey) ?? null;
  }

  /** Get client by key */
  getClient(key: string): LspClient | null {
    return this.clients.get(key) ?? null;
  }

  /**
   * Start all registered servers. Failures are isolated: a server that cannot
   * start is unregistered so getClientForFile will not route to a dead client.
   */
  async startAll(): Promise<void> {
    const entries = [...this.clients.entries()];
    await Promise.all(
      entries.map(async ([key, client]) => {
        try {
          await client.start();
        } catch {
          this.unregisterServer(key);
          try {
            await client.stop();
          } catch {
            // ignore cleanup errors
          }
        }
      }),
    );
  }

  /** Stop all registered servers */
  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
    this.fileTypeMap.clear();
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
    return EXT_TO_LANGUAGE_ID[ext] ?? ext;
  }
}

// ── Language server catalog (not an enable-list) ───────────
//
// This is a discovery catalog of common language servers. Entries are only
// registered when at least one candidate command is found on PATH. Prefer
// probing over hard-coding a tiny enable set.

interface LspServerCandidate {
  /** Preferred binary names, tried in order */
  commands: string[];
  args?: string[];
  fileTypes: string[];
  initOptions?: Record<string, unknown>;
  /** npm package used for best-effort automatic installation when missing. */
  npmPackage?: string | string[];
}

/**
 * Discovery catalog of common language servers. This is NOT an enable-list:
 * entries are registered only when a candidate binary is found on PATH or in
 * the workspace `node_modules/.bin` (and ancestors). Prefer probing over a
 * tiny hard-coded enable set.
 */
const LANGUAGE_SERVER_CATALOG: Record<string, LspServerCandidate> = {
  typescript: {
    commands: ["typescript-language-server"],
    args: ["--stdio"],
    fileTypes: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
    npmPackage: ["typescript-language-server", "typescript"],
  },
  // Deno can also serve TS/JS when present; registered under its own key with
  // overlapping extensions only if typescript-language-server is absent —
  // handled by first-wins fileTypeMap registration order below.
  deno: {
    commands: ["deno"],
    args: ["lsp"],
    fileTypes: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"],
  },
  html: {
    commands: ["vscode-html-language-server", "html-languageserver", "vscode-html-languageserver"],
    args: ["--stdio"],
    fileTypes: ["html", "htm"],
    npmPackage: "vscode-langservers-extracted",
  },
  css: {
    commands: ["vscode-css-language-server", "css-languageserver", "vscode-css-languageserver"],
    args: ["--stdio"],
    fileTypes: ["css", "scss", "less"],
    npmPackage: "vscode-langservers-extracted",
  },
  json: {
    commands: ["vscode-json-language-server", "vscode-json-languageserver"],
    args: ["--stdio"],
    fileTypes: ["json", "jsonc"],
    npmPackage: "vscode-langservers-extracted",
  },
  python: {
    commands: ["pylsp", "pyright-langserver", "basedpyright-langserver", "jedi-language-server"],
    // pyright / basedpyright need --stdio; pylsp/jedi get args via COMMAND_DEFAULT_ARGS.
    fileTypes: ["py", "pyi"],
    npmPackage: "pyright",
  },
  rust: {
    commands: ["rust-analyzer"],
    fileTypes: ["rs"],
  },
  go: {
    commands: ["gopls"],
    fileTypes: ["go"],
  },
  c: {
    commands: ["clangd", "ccls"],
    fileTypes: ["c", "h", "cpp", "cc", "cxx", "hpp", "hxx", "hh", "m", "mm"],
  },
  java: {
    commands: ["jdtls", "java-language-server"],
    fileTypes: ["java"],
  },
  ruby: {
    commands: ["solargraph", "ruby-lsp"],
    fileTypes: ["rb", "rake", "gemspec"],
  },
  php: {
    commands: ["intelephense", "phpactor"],
    fileTypes: ["php"],
  },
  lua: {
    commands: ["lua-language-server"],
    fileTypes: ["lua"],
  },
  bash: {
    commands: ["bash-language-server"],
    args: ["start"],
    fileTypes: ["sh", "bash", "zsh", "ksh"],
  },
  yaml: {
    commands: ["yaml-language-server"],
    args: ["--stdio"],
    fileTypes: ["yaml", "yml"],
    npmPackage: "yaml-language-server",
  },
  toml: {
    commands: ["taplo"],
    args: ["lsp", "stdio"],
    fileTypes: ["toml"],
  },
  markdown: {
    commands: ["marksman"],
    fileTypes: ["md", "markdown", "mdx"],
    // marksman is a Go binary, not an npm package - no npmPackage needed
  },
  docker: {
    commands: ["docker-langserver", "dockerfile-language-server-nodejs"],
    args: ["--stdio"],
    fileTypes: ["dockerfile"],
    npmPackage: "dockerfile-language-server-nodejs",
  },
  kotlin: {
    commands: ["kotlin-language-server"],
    fileTypes: ["kt", "kts"],
  },
  scala: {
    commands: ["metals"],
    fileTypes: ["scala", "sc"],
  },
  zig: {
    commands: ["zls"],
    fileTypes: ["zig", "zon"],
  },
  elixir: {
    commands: ["elixir-ls", "language_server.sh"],
    fileTypes: ["ex", "exs"],
  },
  erlang: {
    commands: ["erlang_ls", "elp"],
    fileTypes: ["erl", "hrl"],
  },
  haskell: {
    commands: ["haskell-language-server-wrapper", "haskell-language-server"],
    args: ["--lsp"],
    fileTypes: ["hs", "lhs"],
  },
  csharp: {
    commands: ["csharp-ls", "OmniSharp"],
    fileTypes: ["cs", "csx"],
  },
  fsharp: {
    commands: ["fsautocomplete"],
    args: ["--adaptive-lsp-server-enabled"],
    fileTypes: ["fs", "fsi", "fsx"],
  },
  vue: {
    commands: ["vue-language-server", "vls"],
    args: ["--stdio"],
    fileTypes: ["vue"],
    npmPackage: "@vue/language-server",
  },
  svelte: {
    commands: ["svelteserver", "svelte-language-server"],
    args: ["--stdio"],
    fileTypes: ["svelte"],
    npmPackage: "svelte-language-server",
  },
  prisma: {
    commands: ["prisma-language-server"],
    args: ["--stdio"],
    fileTypes: ["prisma"],
    npmPackage: "@prisma/language-server",
  },
  graphql: {
    commands: ["graphql-lsp"],
    args: ["server", "--method", "stream"],
    fileTypes: ["graphql", "gql"],
    npmPackage: "graphql-language-service-cli",
  },
  terraform: {
    commands: ["terraform-ls"],
    args: ["serve"],
    fileTypes: ["tf", "tfvars"],
  },
  nix: {
    commands: ["nil", "rnix-lsp"],
    fileTypes: ["nix"],
  },
  r: {
    commands: ["r-languageserver"],
    fileTypes: ["r", "R"],
  },
  dart: {
    commands: ["dart"],
    args: ["language-server", "--protocol=lsp"],
    fileTypes: ["dart"],
  },
  swift: {
    commands: ["sourcekit-lsp"],
    fileTypes: ["swift"],
  },
  perl: {
    commands: ["perlnavigator", "perl-languageserver"],
    args: ["--stdio"],
    fileTypes: ["pl", "pm", "t"],
  },
  cmake: {
    commands: ["cmake-language-server"],
    fileTypes: ["cmake"],
  },
  powershell: {
    commands: ["powershell-editor-services"],
    fileTypes: ["ps1", "psm1", "psd1"],
  },
  xml: {
    commands: ["lemminx"],
    fileTypes: ["xml", "xsd", "xsl", "xslt", "svg"],
  },
  sql: {
    commands: ["sql-language-server", "sqls"],
    fileTypes: ["sql"],
  },
  proto: {
    commands: ["bufls", "protols", "protobuf-language-server"],
    fileTypes: ["proto"],
  },
  latex: {
    commands: ["texlab"],
    fileTypes: ["tex", "sty", "cls", "bib"],
  },
  ocaml: {
    commands: ["ocamllsp"],
    fileTypes: ["ml", "mli", "mll", "mly"],
  },
  clojure: {
    commands: ["clojure-lsp"],
    fileTypes: ["clj", "cljs", "cljc", "edn"],
  },
  julia: {
    commands: ["julia"],
    args: ["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"],
    fileTypes: ["jl"],
  },
  fortran: {
    commands: ["fortls"],
    fileTypes: ["f90", "f95", "f03", "f08", "f", "for", "f77"],
  },
  solidity: {
    commands: ["nomicfoundation-solidity-language-server", "solidity-ls", "solc"],
    args: ["--stdio"],
    fileTypes: ["sol"],
  },
  tailwindcss: {
    commands: ["tailwindcss-language-server"],
    args: ["--stdio"],
    fileTypes: ["html", "css", "scss", "less", "vue", "svelte", "jsx", "tsx"],
    npmPackage: "@tailwindcss/language-server",
  },
  biome: {
    commands: ["biome"],
    args: ["lsp-proxy"],
    fileTypes: ["js", "jsx", "ts", "tsx", "json", "jsonc", "css"],
  },
  eslint: {
    commands: ["vscode-eslint-language-server", "eslint-lsp"],
    args: ["--stdio"],
    fileTypes: ["js", "jsx", "ts", "tsx", "vue", "svelte"],
  },
  vim: {
    commands: ["vim-language-server"],
    args: ["--stdio"],
    fileTypes: ["vim"],
    npmPackage: "vim-language-server",
  },
  ansible: {
    commands: ["ansible-language-server"],
    args: ["--stdio"],
    fileTypes: ["yaml", "yml"],
  },
  groovy: {
    commands: ["groovy-language-server"],
    fileTypes: ["groovy", "gradle"],
  },
  crystal: {
    commands: ["crystalline", "scry"],
    fileTypes: ["cr"],
  },
  nim: {
    commands: ["nimlangserver", "nimlsp"],
    fileTypes: ["nim", "nims"],
  },
  v: {
    commands: ["v-analyzer", "vls"],
    fileTypes: ["v", "vv"],
  },
  lean: {
    commands: ["lean"],
    args: ["--server"],
    fileTypes: ["lean"],
  },
  elm: {
    commands: ["elm-language-server"],
    fileTypes: ["elm"],
    npmPackage: "elm-language-server",
  },
  pureScript: {
    commands: ["purescript-language-server"],
    args: ["--stdio"],
    fileTypes: ["purs"],
    npmPackage: "purescript-language-server",
  },
  reason: {
    commands: ["ocamllsp"],
    fileTypes: ["re", "rei"],
  },
  rescript: {
    commands: ["rescript-language-server"],
    args: ["--stdio"],
    fileTypes: ["res", "resi"],
    // ReScript's language server is embedded in the rescript-vscode extension
    // and not available as a standalone npm package
  },
  astro: {
    commands: ["astro-ls"],
    args: ["--stdio"],
    fileTypes: ["astro"],
    npmPackage: "@astrojs/language-server",
  },
  glsl: {
    commands: ["glsl_analyzer", "glslls"],
    fileTypes: ["glsl", "vert", "frag", "comp"],
  },
  wgsl: {
    commands: ["wgsl_analyzer"],
    fileTypes: ["wgsl"],
  },
};

/** Extension → LSP languageId mapping used when opening documents. */
const EXT_TO_LANGUAGE_ID: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mts: "typescript",
  cts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "jsonc",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  hh: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  lua: "lua",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  dockerfile: "dockerfile",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  zig: "zig",
  zon: "zig",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  lhs: "haskell",
  cs: "csharp",
  csx: "csharp",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  vue: "vue",
  svelte: "svelte",
  prisma: "prisma",
  graphql: "graphql",
  gql: "graphql",
  tf: "terraform",
  tfvars: "terraform",
  nix: "nix",
  r: "r",
  dart: "dart",
  swift: "swift",
  pl: "perl",
  pm: "perl",
  t: "perl",
  cmake: "cmake",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  svg: "xml",
  sql: "sql",
  proto: "proto",
  tex: "latex",
  sty: "latex",
  cls: "latex",
  bib: "bibtex",
  ml: "ocaml",
  mli: "ocaml",
  mll: "ocaml",
  mly: "ocaml",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  jl: "julia",
  f90: "fortran",
  f95: "fortran",
  f03: "fortran",
  f08: "fortran",
  f: "fortran",
  for: "fortran",
  f77: "fortran",
  sol: "solidity",
  vim: "vim",
  groovy: "groovy",
  gradle: "groovy",
  cr: "crystal",
  nim: "nim",
  nims: "nim",
  v: "v",
  vv: "v",
  lean: "lean",
  elm: "elm",
  purs: "purescript",
  re: "reason",
  rei: "reason",
  res: "rescript",
  resi: "rescript",
  astro: "astro",
  glsl: "glsl",
  vert: "glsl",
  frag: "glsl",
  comp: "glsl",
  wgsl: "wgsl",
};

/**
 * Per-binary default args when the catalog entry has no shared `args`,
 * or when a specific binary needs different flags than its siblings.
 */
const COMMAND_DEFAULT_ARGS: Record<string, string[]> = {
  "pyright-langserver": ["--stdio"],
  "basedpyright-langserver": ["--stdio"],
  intelephense: ["--stdio"],
  phpactor: ["language-server"],
  svelteserver: ["--stdio"],
  "svelte-language-server": ["--stdio"],
  "vue-language-server": ["--stdio"],
  vls: ["--stdio"],
  OmniSharp: ["-lsp"],
  solargraph: ["stdio"],
  "ruby-lsp": [],
  "sql-language-server": ["up", "--method", "stdio"],
  sqls: [],
  bufls: ["serve"],
  protols: [],
  "perl-languageserver": [],
  perlnavigator: ["--stdio"],
  "nomicfoundation-solidity-language-server": ["--stdio"],
  "solidity-ls": ["--stdio"],
  "vscode-markdown-language-server": ["--stdio"],
  "dockerfile-language-server-nodejs": ["--stdio"],
  "docker-langserver": ["--stdio"],
  "astro-ls": ["--stdio"],
  "rescript-language-server": ["--stdio"],
  "purescript-language-server": ["--stdio"],
  "elm-language-server": ["--stdio"],
  "vim-language-server": ["--stdio"],
  "ansible-language-server": ["--stdio"],
  "tailwindcss-language-server": ["--stdio"],
  "vscode-eslint-language-server": ["--stdio"],
  "eslint-lsp": ["--stdio"],
  biome: ["lsp-proxy"],
  crystalline: [],
  scry: [],
  nimlangserver: [],
  nimlsp: [],
  "v-analyzer": [],
  glsl_analyzer: [],
  glslls: [],
  wgsl_analyzer: [],
  fortls: [],
  "clojure-lsp": [],
  ocamllsp: [],
  texlab: [],
  lemminx: [],
  fsautocomplete: ["--adaptive-lsp-server-enabled"],
  erlang_ls: [],
  elp: ["server"],
  "java-language-server": [],
  ccls: [],
};

/** Cache key → whether a bare command name resolves on PATH. */
const pathAvailabilityCache = new Map<string, boolean>();
const installPromiseCache = new Map<string, Promise<string | null>>();
const installQueue = new Map<string, Promise<void>>();

function shouldPreferChinaMirror(): boolean {
  if (process.env.OWNCODER_NPM_REGISTRY) return false;
  const locale = `${process.env.LANG ?? ""} ${process.env.LANGUAGE ?? ""} ${process.env.LC_ALL ?? ""}`.toLowerCase();
  return process.env.OWNCODER_REGION === "cn" ||
    process.env.TZ === "Asia/Shanghai" ||
    locale.includes("zh_cn") ||
    locale.includes("zh-cn");
}

function npmRegistry(): string {
  return process.env.OWNCODER_NPM_REGISTRY ??
    (shouldPreferChinaMirror() ? "https://registry.npmmirror.com" : "https://registry.npmjs.org");
}

async function installNpmLanguageServer(
  entry: LspServerCandidate,
  cwd: string,
): Promise<string | null> {
  if (!entry.npmPackage || process.env.OWNCODER_DISABLE_LSP_AUTO_INSTALL === "1") return null;
  const installRoot = path.join(cwd, ".owncoder", "lsp");
  const packages = Array.isArray(entry.npmPackage) ? entry.npmPackage : [entry.npmPackage];
  const cacheKey = `${installRoot}:${packages.join(",")}`;
  const existing = installPromiseCache.get(cacheKey);
  if (existing) return existing;

  const previousInstall = installQueue.get(installRoot) ?? Promise.resolve();
  const promise = previousInstall.catch(() => undefined).then(async () => {
    try {
      await fs.mkdir(installRoot, { recursive: true });
      const npmArgs = [
        "install",
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--prefix",
        installRoot,
        ...packages,
        "--registry",
        npmRegistry(),
      ];
      await runLspNpmInstall(npmArgs, cwd);
      for (const command of entry.commands) {
        const local = resolveLocalBin(cwd, command);
        if (local) return local;
      }
    } catch (error) {
      console.warn(`[LSP] 自动安装 ${packages.join(", ")} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  });
  installQueue.set(installRoot, promise.then(() => undefined, () => undefined));
  installPromiseCache.set(cacheKey, promise);
  return promise;
}

/** Return true if `command` resolves on PATH (cached). */
async function isCommandOnPath(command: string): Promise<boolean> {
  const cached = pathAvailabilityCache.get(command);
  if (cached !== undefined) return cached;

  const isWin = process.platform === "win32";
  try {
    if (isWin) {
      await execFileAsync("where.exe", [command], { windowsHide: true });
    } else {
      await execFileAsync("which", [command]);
    }
    pathAvailabilityCache.set(command, true);
    return true;
  } catch {
    pathAvailabilityCache.set(command, false);
    return false;
  }
}

/**
 * Resolve a binary from workspace-local `node_modules/.bin`, walking up from
 * `cwd` toward the filesystem root (supports monorepo nested packages).
 * On Windows, also tries `.cmd` / `.exe` shims.
 */
function resolveLocalBin(cwd: string, command: string): string | null {
  const isWin = process.platform === "win32";
  const suffixes = isWin ? ["", ".cmd", ".exe", ".ps1"] : [""];
  let dir = path.resolve(cwd);

  for (;;) {
    for (const binDir of [
      path.join(dir, "node_modules", ".bin"),
      path.join(dir, ".owncoder", "lsp", "node_modules", ".bin"),
    ]) {
      for (const suffix of suffixes) {
        const candidate = path.join(binDir, command + suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Pick the first catalog command available either as a workspace-local bin or
 * on PATH. Local bins win so project-pinned language servers are preferred.
 */
async function resolveCatalogEntry(
  entry: LspServerCandidate,
  cwd: string,
  autoInstall = false,
): Promise<LspClientConfig | null> {
  if (!entry.commands.length) return null;

  for (const command of entry.commands) {
    const local = resolveLocalBin(cwd, command);
    const available = local !== null || (await isCommandOnPath(command));
    if (!available) continue;

    const args =
      entry.args && entry.args.length > 0
        ? [...entry.args]
        : (COMMAND_DEFAULT_ARGS[command] ?? []);

    const nodeEntry = local ? resolveLspNodeEntry(local, command) : null;
    const runtime = nodeEntry ? lspNodeRuntime() : null;
    return {
      command: runtime?.command ?? local ?? command,
      args: nodeEntry ? [nodeEntry, ...args] : args,
      env: runtime?.env,
      fileTypes: entry.fileTypes,
      initOptions: entry.initOptions,
    };
  }
  if (autoInstall) {
    const installed = await installNpmLanguageServer(entry, cwd);
    if (installed) {
      const command = entry.commands.find((candidate) => resolveLocalBin(cwd, candidate));
      if (command) {
        return resolveCatalogEntry(entry, cwd, false);
      }
    }
  }
  return null;
}

async function detectProjectFileTypes(cwd: string): Promise<Set<string>> {
  const result = new Set<string>();
  const queue = [path.resolve(cwd)];
  let visited = 0;
  while (queue.length && visited < 5000) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".owncoder") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else {
        const ext = path.extname(entry.name).toLowerCase().slice(1);
        if (ext) result.add(ext);
        if (entry.name.toLowerCase() === "dockerfile") result.add("dockerfile");
      }
      visited++;
      if (visited >= 5000) break;
    }
  }
  return result;
}

/**
 * Create a manager and register every catalog language server whose binary is
 * available on PATH or in workspace `node_modules/.bin`. Unavailable servers
 * are skipped (not hard-enabled). Registration is first-wins for overlapping
 * extensions (catalog object order). Call startAll() afterwards; failed starts
 * are unregistered automatically.
 */
export async function createDefaultLspManager(cwd: string): Promise<LspClientManager> {
  const manager = new LspClientManager(cwd);
  const projectFileTypes = await detectProjectFileTypes(cwd);
  const resolved = await Promise.all(
    Object.entries(LANGUAGE_SERVER_CATALOG).map(async ([key, entry]) => {
      if (!entry.commands.length || !entry.fileTypes.length) return null;
      const installOnlyProjectLanguages = process.env.OWNCODER_LSP_INSTALL_PROJECT_ONLY === "1";
      const usedByProject = entry.fileTypes.some((fileType) => projectFileTypes.has(fileType.toLowerCase()));
      if (!installOnlyProjectLanguages && !usedByProject) {
        // Pre-download supported npm servers, but do not start every server in
        // every project. Only servers matching project files are registered.
        await installNpmLanguageServer(entry, cwd);
        return null;
      }
      const config = await resolveCatalogEntry(entry, cwd, usedByProject);
      return config ? ([key, config] as const) : null;
    }),
  );
  for (const item of resolved) {
    if (!item) continue;
    const [key, config] = item;
    // First-wins: do not overwrite extensions already claimed by an earlier
    // catalog entry (e.g. typescript before deno/biome/eslint).
    const freeTypes = config.fileTypes.filter((ft) => !manager.getClientForFile(`x.${ft}`));
    if (freeTypes.length === 0) continue;
    manager.registerServer(key, { ...config, fileTypes: freeTypes });
  }
  return manager;
}
