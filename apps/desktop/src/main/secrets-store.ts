import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretsState {
  llmApiKey: string | null;
}

const EMPTY: SecretsState = { llmApiKey: null };

/** User LLM credentials (userData/owncoder/secrets.json). Not synced to project. */
export class SecretsStore {
  private file: string;

  constructor(userDataDir: string) {
    const dir = join(userDataDir, "owncoder");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "secrets.json");
  }

  load(): SecretsState {
    if (!existsSync(this.file)) return { ...EMPTY };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SecretsState>;
      const key = typeof raw.llmApiKey === "string" ? raw.llmApiKey.trim() : "";
      return { llmApiKey: key || null };
    } catch {
      return { ...EMPTY };
    }
  }

  save(partial: Partial<SecretsState>): SecretsState {
    const prev = this.load();
    const next: SecretsState = {
      llmApiKey:
        partial.llmApiKey === undefined
          ? prev.llmApiKey
          : partial.llmApiKey?.trim()
            ? partial.llmApiKey.trim()
            : null,
    };
    writeFileSync(this.file, JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
  }
}
