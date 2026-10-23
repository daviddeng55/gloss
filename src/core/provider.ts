// Where the AI runs. Every model call in Gloss goes through one `ModelProvider`, so the place the models
// run can be swapped without touching the features that use them: Ollama on this Mac, or Gemini (Google's
// cloud models) in fast mode. ai.ts holds the prompts and decides which one to use; this file only moves bytes.
import { redact } from "./redact.ts";

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
  readonly code: "not-running" | "model-missing" | "bad-output" | "failed" | "offline" | "rate-limited" | "bad-key";
  /** For "rate-limited": how long the provider asked us to wait, if it said. */
  readonly retryAfterMs?: number;
  constructor(code: AiError["code"], message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
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
  /** Frees memory used by every model except those in `keep` (no-op where that doesn't apply). */
  unloadOthers(keep: string[]): Promise<void>;
  /** Loads a model into memory ahead of use, so the first answer doesn't wait for it (optional). */
  load?(model: string): Promise<void>;
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

  async unloadOthers(keep: string[]): Promise<void> {
    const ps = (await (await fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: { name: string }[] };
    for (const m of ps.models ?? []) {
      if (keep.some((k) => m.name === k || m.name === `${k}:latest`)) continue;
      await fetch(`${this.baseUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(10_000) });
    }
  }

  async load(model: string): Promise<void> {
    await this.post("/api/generate", JSON.stringify({ model, keep_alive: KEEP_ALIVE }), AbortSignal.timeout(60_000), model);
  }
}

/** The fastest Gemini Flash model (Google's docs, Oct 2026: "our fastest, most cost-effective 3.5 model"). */
export const GEMINI_FAST_MODEL = "gemini-3.5-flash-lite";

/** Gemini replies must start within this long, or we give up and use the local model instead. */
const FIRST_PIECE_MS = 20_000;
/** Once started, a reply that goes quiet this long has stalled (Gemini normally sends pieces every ~0.1 s). */
const STALL_MS = 15_000;
/** Longest reply we'll accept (a model stuck repeating itself shouldn't run until the timeout). */
const MAX_REPLY_CHARS = 60_000;

/** JPEG or PNG, from the first bytes of the base64 text. */
function imageType(base64: string): string {
  return base64.startsWith("iVBOR") ? "image/png" : "image/jpeg";
}

/**
 * The least thinking each Gemini model allows (thinking adds seconds before the first word). Gemini 3.x
 * Flash-Lite and Flash take "minimal", 3.8 Flash only goes down to "low", 2.5 Flash turns off with a budget of 0.
 */
function leastThinking(model: string): object {
  if (/^gemini-2\./.test(model)) return /lite/.test(model) ? {} : { thinkingConfig: { thinkingBudget: 0 } };
  if (/^gemini-3\.8/.test(model)) return { thinkingConfig: { thinkingLevel: "low" } };
  return { thinkingConfig: { thinkingLevel: "minimal" } };
}

/**
 * Google's Gemini models in the cloud, with the student's own API key (kept in the macOS Keychain; this
 * class only holds it in memory). Every piece of text is passed through the redaction filter again on its
 * way out. Used only when the student turned on fast mode; ai.ts falls back to Ollama if a call fails.
 */
export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";
  readonly baseUrl: string;
  private key: string;
  private stallMs: number;

  constructor(key: string, baseUrl = "https://generativelanguage.googleapis.com/v1beta", opts: { stallMs?: number } = {}) {
    this.key = key;
    this.baseUrl = baseUrl;
    this.stallMs = opts.stallMs ?? STALL_MS;
  }

  /** Gemini's request format. Exported shape for tests via `requestBody`. */
  requestBody(req: ChatRequest, withThinking = true): string {
    const clean = (t: string) => redact(t).text;
    const system = req.messages.filter((m) => m.role === "system").map((m) => clean(m.content)).join("\n\n");
    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [...(m.images ?? []).map((data) => ({ inlineData: { mimeType: imageType(data), data } })), { text: clean(m.content) }],
      }));
    return JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: req.maxTokens ?? 8192,
        ...(req.stop ? { stopSequences: req.stop.slice(0, 5) } : {}),
        ...(req.schema ? { responseMimeType: "application/json", responseJsonSchema: req.schema } : {}),
        ...(withThinking && !req.think ? leastThinking(req.model) : {}),
      },
    });
  }

  /** Turns an error reply into an AiError (never including the key). */
  private async failure(res: Response, model: string): Promise<AiError> {
    const text = await res.text().catch(() => "");
    let message = text;
    let reason = ""; // Google's code for what went wrong, e.g. "API_KEY_INVALID"
    let retryAfterMs: number | undefined;
    try {
      const err = (JSON.parse(text) as { error?: { message?: string; details?: { retryDelay?: string; reason?: string }[] } }).error;
      message = err?.message ?? text;
      reason = err?.details?.find((d) => d.reason)?.reason ?? "";
      const delay = err?.details?.find((d) => d.retryDelay)?.retryDelay; // e.g. "17s"
      if (delay) retryAfterMs = Math.ceil(parseFloat(delay) * 1000);
    } catch {
      /* not JSON */
    }
    const header = Number(res.headers.get("retry-after"));
    if (!retryAfterMs && header > 0) retryAfterMs = header * 1000;
    message = message.replaceAll(this.key, "…").slice(0, 200);
    if (res.status === 429) return new AiError("rate-limited", "Gemini's rate limit was reached.", retryAfterMs);
    if (reason === "ACCESS_TOKEN_TYPE_UNSUPPORTED" || reason === "API_KEY_SERVICE_BLOCKED") {
      // A known problem on Google's side with some new "AQ." keys (Google AI forum, Sep–Oct 2026).
      return new AiError(
        "bad-key",
        `Google refused this key (${reason}). This happens with some new "AQ." keys from AI Studio. Try making a new key in AI Studio, ` +
          `or a standard key: console.cloud.google.com → APIs & Services → Credentials → Create credentials → API key, restricted to the "Generative Language API".`,
      );
    }
    if (res.status === 401 || res.status === 403 || /api[_ ]key/i.test(message)) {
      return new AiError("bad-key", `Gemini didn't accept the API key (Google says: ${message || `error ${res.status}`}${reason ? `, ${reason}` : ""}).`);
    }
    if (res.status === 404) return new AiError("model-missing", `Gemini has no model called "${model}".`);
    return new AiError("failed", `Gemini error ${res.status}: ${message}`);
  }

  async chat(req: ChatRequest): Promise<string> {
    return this.stream(req, () => {});
  }

  async stream(req: ChatRequest, onText: (piece: string) => boolean | void): Promise<string> {
    const abort = new AbortController();
    const giveUp = (why: string) => abort.abort(new DOMException(why, "TimeoutError"));
    // Gives up if nothing arrives for a while: first while waiting for the answer to start, then (shorter)
    // between pieces, so a connection that stalls or never closes falls back to the local model quickly.
    let quiet = setTimeout(() => giveUp("Gemini didn't start answering in time."), FIRST_PIECE_MS);
    const heardFrom = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => giveUp("Gemini stopped sending its answer."), this.stallMs);
    };
    const timer = setTimeout(() => giveUp("Gemini took too long to answer."), req.timeoutMs ?? 90_000);
    let stopped = false;
    let finished = false;
    let text = "";
    try {
      const send = (withThinking: boolean) =>
        fetch(`${this.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
          body: this.requestBody(req, withThinking),
          signal: abort.signal,
        });
      let res = await send(true);
      // A model that doesn't take our thinking setting: ask again with its default.
      if (res.status === 400) {
        const body = await res.clone().text();
        if (/thinking/i.test(body)) res = await send(false);
      }
      if (!res.ok) throw await this.failure(res, req.model);
      if (!res.body) throw new AiError("failed", "Gemini sent an empty reply.");
      let buffer = "";
      const decoder = new TextDecoder();
      reading: for await (const chunk of res.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          heardFrom();
          const part = JSON.parse(line.slice(5)) as {
            candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
            promptFeedback?: { blockReason?: string };
            error?: { message?: string };
          };
          if (part.error) throw new AiError("failed", `Gemini: ${part.error.message ?? "error"}`);
          if (part.promptFeedback?.blockReason) throw new AiError("failed", `Gemini declined this (${part.promptFeedback.blockReason}).`);
          const candidate = part.candidates?.[0];
          const piece = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
          if (piece) {
            text += piece;
            if (text.length > MAX_REPLY_CHARS) throw new AiError("bad-output", "Gemini's answer ran on far too long.");
            if (onText(piece) === false) {
              stopped = true;
              abort.abort();
              break reading;
            }
          }
          // Gemini says it's finished: done, even if the connection stays open.
          if (candidate?.finishReason) {
            if (candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS" && !text) {
              throw new AiError("failed", `Gemini stopped without answering (${candidate.finishReason}).`);
            }
            finished = true;
            break reading;
          }
        }
      }
      if (!text) throw new AiError("failed", "Gemini sent an empty reply.");
    } catch (err) {
      if (stopped || (finished && text)) return text;
      if (err instanceof AiError) throw err;
      if (abort.signal.aborted) throw new AiError("failed", (abort.signal.reason as Error)?.message ?? "Gemini took too long to answer.");
      if (err instanceof SyntaxError) throw new AiError("failed", "Gemini sent a reply we couldn't read.");
      throw new AiError("offline", "Couldn't reach Gemini (no internet connection?).");
    } finally {
      clearTimeout(quiet);
      clearTimeout(timer);
    }
    return text;
  }

  async embed(): Promise<number[][]> {
    throw new AiError("failed", "Search by meaning always runs on this Mac.");
  }

  /** The Gemini models this key can use (null if the key or the network doesn't work). */
  async models(): Promise<string[] | null> {
    try {
      const res = await fetch(`${this.baseUrl}/models?pageSize=200`, { headers: { "x-goog-api-key": this.key }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const out = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (out.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
    } catch {
      return null;
    }
  }

  async unloadOthers(): Promise<void> {}
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

  async unloadOthers(_keep: string[]): Promise<void> {}
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
