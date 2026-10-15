// Where the AI runs. Every model call in Gloss goes through one `ModelProvider`, so the place the models
// run can be swapped (Ollama on this Mac today; maybe Apple's on-device model or a cloud model later)
// without touching the features that use them. ai.ts holds the prompts; this file only moves bytes.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string; images?: string[] };

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  /** JSON schema the reply must follow (the reply is still returned as text; ai.ts parses it). */
  schema?: object;
  think?: boolean;
  temperature?: number;
  numCtx?: number;
  /** Longest reply, in tokens. */
  maxTokens?: number;
  stop?: string[];
  timeoutMs?: number;
};

/** Why a call failed, in words a student can act on. */
export class AiError extends Error {
  readonly code: "not-running" | "model-missing" | "bad-output" | "failed";
  constructor(code: AiError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ModelProvider {
  readonly name: string;
  /** One reply, all at once. */
  chat(req: ChatRequest): Promise<string>;
  /**
   * One reply, piece by piece. `onText` gets each new piece; returning `false` stops the reply early
   * (used to cut off a model that starts repeating itself). Resolves with everything received.
   */
  stream(req: ChatRequest, onText: (piece: string) => boolean | void): Promise<string>;
  /** Text -> vectors, for search by meaning. */
  embed(model: string, inputs: string[]): Promise<number[][]>;
  /** Models available, or null if the provider can't be reached. */
  models(): Promise<string[] | null>;
  /** Frees memory used by every model except `keep` (no-op where that doesn't apply). */
  unloadOthers(keep: string): Promise<void>;
}

/** How long Ollama keeps a model in memory after its last use. */
export const KEEP_ALIVE = "3m";

const NOT_RUNNING = "Ollama isn't running. Open the Ollama app, then try again.";

/** Local models through Ollama (http://localhost:11434). */
export class OllamaProvider implements ModelProvider {
  readonly name = "ollama";
  readonly baseUrl: string;

  constructor(baseUrl = "http://localhost:11434") {
    this.baseUrl = baseUrl;
  }

  private body(req: ChatRequest, stream: boolean) {
    return JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream,
      think: req.think ?? false,
      keep_alive: KEEP_ALIVE,
      format: req.schema,
      options: {
        temperature: req.temperature ?? 0.2,
        num_ctx: req.numCtx ?? 8192,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
        ...(req.stop ? { stop: req.stop } : {}),
      },
    });
  }

  private async post(path: string, body: string, signal: AbortSignal, model: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, signal, body });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") throw new AiError("failed", "The AI model took too long to answer.");
      throw new AiError("not-running", NOT_RUNNING);
    }
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 || /not found/i.test(text)) {
        throw new AiError("model-missing", `The AI model isn't downloaded. In a terminal, run: ollama pull ${model}`);
      }
      throw new AiError("failed", `Ollama error ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  }

  async chat(req: ChatRequest): Promise<string> {
    const res = await this.post("/api/chat", this.body(req, false), AbortSignal.timeout(req.timeoutMs ?? 180_000), req.model);
    return ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
  }

  async stream(req: ChatRequest, onText: (piece: string) => boolean | void): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new DOMException("timeout", "TimeoutError")), req.timeoutMs ?? 180_000);
    let stopped = false;
    let text = "";
    try {
      const res = await this.post("/api/chat", this.body(req, true), abort.signal, req.model);
      if (!res.body) throw new AiError("failed", "The AI model sent an empty reply.");
      let buffer = "";
      const decoder = new TextDecoder();
      reading: for await (const chunk of res.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const part = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string };
          if (part.error) throw new AiError("failed", part.error);
          const piece = part.message?.content ?? "";
          if (piece) {
            text += piece;
            if (onText(piece) === false) {
              stopped = true;
              abort.abort();
              break reading;
            }
          }
          if (part.done) break reading;
        }
      }
    } catch (err) {
      if (stopped) return text;
      if (err instanceof AiError) throw err;
      if (abort.signal.aborted) throw new AiError("failed", "The AI model took too long to answer.");
      throw new AiError("failed", `The AI model stopped: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    return text;
  }

  async embed(model: string, inputs: string[]): Promise<number[][]> {
    const res = await this.post("/api/embed", JSON.stringify({ model, input: inputs, keep_alive: KEEP_ALIVE }), AbortSignal.timeout(120_000), model);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  }

  async models(): Promise<string[] | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return (((await res.json()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name);
    } catch {
      return null;
    }
  }

  async unloadOthers(keep: string): Promise<void> {
    const ps = (await (await fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: { name: string }[] };
    for (const m of ps.models ?? []) {
      if (m.name === keep) continue;
      await fetch(`${this.baseUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(10_000) });
    }
  }
}

/**
 * A pretend provider for tests and development checks: never touches the network. `reply` decides
 * what each chat says (by default an empty JSON object), and every request is kept in `calls`.
 */
export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly calls: ChatRequest[] = [];
  reply: (req: ChatRequest) => string;
  available: string[];

  constructor(reply: (req: ChatRequest) => string = () => "{}", available = ["qwen3.5:4b"]) {
    this.reply = reply;
    this.available = available;
  }

  async chat(req: ChatRequest): Promise<string> {
    this.calls.push(req);
    return this.reply(req);
  }

  async stream(req: ChatRequest, onText: (piece: string) => boolean | void): Promise<string> {
    const text = await this.chat(req);
    onText(text);
    return text;
  }

  async embed(_model: string, inputs: string[]): Promise<number[][]> {
    return inputs.map(() => [0]);
  }

  async models(): Promise<string[] | null> {
    return this.available;
  }

  async unloadOthers(): Promise<void> {}
}

// Tests (node --test sets NODE_TEST_CONTEXT) never reach a real model unless they choose to.
let active: ModelProvider = process.env.NODE_TEST_CONTEXT ? new MockProvider(() => "{}", []) : new OllamaProvider();

/** The provider every AI call uses. */
export function provider(): ModelProvider {
  return active;
}

/** Swaps the provider (tests, development checks; later a Settings choice). */
export function setProvider(p: ModelProvider) {
  active = p;
}
