// Fast mode: the Gemini provider's requests and errors, falling back to the local model, the privacy rules,
// and summaries shown point by point. Gemini is played by a local server; Google is never contacted.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { chat, embed, partialPoints, setCloud, streamReply, summarizeSession, tracked, withModel } from "./ai.ts";
import { allFromStudyApps, cleanAppList, DEFAULT_STUDY_APPS, isStudyApp, looksSensitive } from "./cloud.ts";
import { looksLikeApiKey } from "./keychain.ts";
import { AiError, GeminiProvider, MockProvider, provider, setProvider, type ChatRequest } from "./provider.ts";
import { sanitizeSettings, DEFAULT_SETTINGS_FILE } from "./settings.ts";

const KEY = "AIzaTestKey_0123456789abcdefghij";

/** A pretend Gemini on a random local port. */
async function fakeGemini(handle: (req: IncomingMessage, body: any, res: ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => handle(req, raw ? JSON.parse(raw) : null, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** Server-sent events, as streamGenerateContent?alt=sse sends them. */
const sse = (parts: object[]) => parts.map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join("");
const piece = (text: string, thought = false) => ({ candidates: [{ content: { role: "model", parts: [{ text, ...(thought ? { thought } : {}) }] } }] });

test("Gemini: sends Gemini's request format, with the key in a header and text redacted on the way out", async () => {
  let seen: { url: string; key: string | undefined; body: any } | null = null;
  const { url, server } = await fakeGemini((req, body, res) => {
    seen = { url: req.url ?? "", key: req.headers["x-goog-api-key"] as string, body };
    res.setHeader("Content-Type", "text/event-stream");
    // One event split across two writes, and a "thought" part that must not show up.
    const text = sse([piece("thinking…", true), piece("Hel"), piece("lo")]);
    res.write(text.slice(0, 40));
    setTimeout(() => res.end(text.slice(40)), 10);
  });
  try {
    const got: string[] = [];
    const out = await new GeminiProvider(KEY, url).stream(
      {
        model: "gemini-3.5-flash-lite",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "My password: hunter2. What is 2+2?", images: ["/9j/4AAQ"] },
          { role: "assistant", content: "4" },
        ],
        schema: { type: "object" },
        temperature: 0.3,
      },
      (p) => void got.push(p),
    );
    assert.equal(out, "Hello");
    assert.deepEqual(got, ["Hel", "lo"]);
    assert.ok(seen);
    const s = seen as { url: string; key: string | undefined; body: any };
    assert.equal(s.url, "/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse");
    assert.equal(s.key, KEY);
    assert.ok(!s.url.includes(KEY), "the key is never in the URL");
    assert.deepEqual(s.body.systemInstruction, { parts: [{ text: "Be brief." }] });
    assert.deepEqual(s.body.contents.map((c: any) => c.role), ["user", "model"]);
    assert.deepEqual(s.body.contents[0].parts[0], { inlineData: { mimeType: "image/jpeg", data: "/9j/4AAQ" } });
    assert.match(s.body.contents[0].parts[1].text, /password \[redacted\]/);
    assert.ok(!JSON.stringify(s.body).includes("hunter2"));
    assert.equal(s.body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(s.body.generationConfig.responseJsonSchema, { type: "object" });
    assert.deepEqual(s.body.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
    assert.equal(s.body.generationConfig.temperature, 0.3);
  } finally {
    server.close();
  }
});

test("Gemini: rate limits, bad keys and missing models become clear errors (never showing the key)", async () => {
  let reply: { status: number; body: object } = { status: 429, body: { error: { message: "Quota exceeded", details: [{ "@type": "RetryInfo", retryDelay: "17s" }] } } };
  const { url, server } = await fakeGemini((_req, _body, res) => {
    res.statusCode = reply.status;
    res.end(JSON.stringify(reply.body));
  });
  const ask = () => new GeminiProvider(KEY, url).chat({ model: "gemini-x", messages: [{ role: "user", content: "hi" }] });
  try {
    await assert.rejects(ask(), (e: AiError) => e.code === "rate-limited" && e.retryAfterMs === 17_000);
    reply = { status: 400, body: { error: { message: `API key not valid: ${KEY}`, status: "INVALID_ARGUMENT" } } };
    await assert.rejects(ask(), (e: AiError) => e.code === "bad-key" && !e.message.includes(KEY));
    // The known problem with some new "AQ." keys gets its own advice.
    reply = {
      status: 401,
      body: { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED", details: [{ reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED" }] } },
    };
    await assert.rejects(ask(), (e: AiError) => e.code === "bad-key" && /ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(e.message) && /Credentials/.test(e.message));
    reply = { status: 404, body: { error: { message: "models/gemini-x is not found" } } };
    await assert.rejects(ask(), (e: AiError) => e.code === "model-missing");
    reply = { status: 503, body: { error: { message: "overloaded" } } };
    await assert.rejects(ask(), (e: AiError) => e.code === "failed");
  } finally {
    server.close();
  }
  // Nothing listening there any more: offline.
  await assert.rejects(ask(), (e: AiError) => e.code === "offline");
});

test("Gemini: a model that won't take the thinking setting is asked again without it", async () => {
  const bodies: any[] = [];
  const { url, server } = await fakeGemini((_req, body, res) => {
    bodies.push(body);
    if (body.generationConfig.thinkingConfig) {
      res.statusCode = 400;
      return void res.end(JSON.stringify({ error: { message: "Thinking level MINIMAL is not supported for this model." } }));
    }
    res.end(sse([piece("ok")]));
  });
  try {
    assert.equal(await new GeminiProvider(KEY, url).chat({ model: "gemini-9-flash", messages: [{ role: "user", content: "hi" }] }), "ok");
    assert.equal(bodies.length, 2);
  } finally {
    server.close();
  }
});

/** A cloud model that answers with `reply`, or fails with `fail`; counts its calls. */
class FakeCloud extends MockProvider {
  fail: AiError | null = null;
  constructor(reply: (req: ChatRequest) => string) {
    super(reply, ["gemini-test"]);
  }
  override async chat(req: ChatRequest): Promise<string> {
    this.calls.push(req);
    if (this.fail) throw this.fail;
    return this.reply(req);
  }
  override async stream(req: ChatRequest, onText: (piece: string) => boolean | void): Promise<string> {
    this.calls.push(req);
    const text = this.reply(req);
    onText(text.slice(0, 3)); // part of the answer arrives…
    if (this.fail) throw this.fail; // …then the connection drops
    onText(text.slice(3));
    return text;
  }
}

test("fast mode: the cloud answers when allowed; otherwise, or if it fails, the local model does", async () => {
  const local = new MockProvider(() => '{"from":"local"}');
  const cloud = new FakeCloud(() => '{"from":"cloud"}');
  const before = provider();
  setProvider(local);
  setCloud({ provider: cloud, model: "gemini-test" });
  const req = { messages: [{ role: "user" as const, content: "hi" }], schema: { type: "object" } };
  try {
    // Allowed (study apps only): the cloud answers, with its own model name, and it's marked.
    const a = await tracked(() => chat<{ from: string }>({ model: "qwen", cloud: true }, req));
    assert.deepEqual(a, { value: { from: "cloud" }, cloud: true });
    assert.equal(cloud.calls[0].model, "gemini-test");
    assert.equal(local.calls.length, 0);

    // Not allowed: never sent.
    const b = await tracked(() => chat<{ from: string }>({ model: "qwen" }, req));
    assert.deepEqual(b, { value: { from: "local" }, cloud: false });
    assert.equal(cloud.calls.length, 1);

    // Rate limit: the local model answers, and the cloud is left alone for the time it asked.
    cloud.fail = new AiError("rate-limited", "Gemini's rate limit was reached.", 60_000);
    const c = await tracked(() => chat<{ from: string }>({ model: "qwen", cloud: true }, req));
    assert.deepEqual(c, { value: { from: "local" }, cloud: false });
    assert.equal(cloud.calls.length, 2);
    await chat({ model: "qwen", cloud: true }, req);
    assert.equal(cloud.calls.length, 2, "paused after the rate limit: not even tried");

    // Settings changed (setCloud): tried again. A reply that isn't JSON also falls back.
    setCloud({ provider: cloud, model: "gemini-test" });
    cloud.fail = null;
    cloud.reply = () => "Sure! Here you go";
    assert.deepEqual(await chat({ model: "qwen", cloud: true }, req), { from: "local" });
  } finally {
    setCloud(null);
    setProvider(before);
  }
});

test("fast mode: if the cloud fails partway through an answer, it starts over on the local model", async () => {
  const local = new MockProvider(() => "Local answer");
  const cloud = new FakeCloud(() => "Cloud answer");
  cloud.fail = new AiError("offline", "Couldn't reach Gemini.");
  const before = provider();
  setProvider(local);
  setCloud({ provider: cloud, model: "gemini-test" });
  try {
    const starts: boolean[] = [];
    let shown = "";
    const text = await streamReply(
      { model: "qwen", cloud: true },
      { messages: [{ role: "user", content: "hi" }] },
      (p) => void (shown += p),
      (fromCloud) => {
        starts.push(fromCloud);
        shown = ""; // the window clears what it showed
      },
    );
    assert.deepEqual(starts, [true, false]);
    assert.equal(text, "Local answer");
    assert.equal(shown, "Local answer");
  } finally {
    setCloud(null);
    setProvider(before);
  }
});

test("local models: the small embedding model stays loaded next to the chat model", async () => {
  const unloads: string[][] = [];
  const p = new MockProvider(() => "ok");
  p.unloadOthers = async (keep: string[]) => void unloads.push(keep);
  const before = provider();
  setProvider(p);
  try {
    await withModel({ model: "qwen-test" }, async () => "a");
    await embed(["question"], "query");
    await withModel({ model: "qwen-test" }, async () => "b");
    await withModel({ model: "glm-test" }, async () => "c");
    // Switching to the embedder unloads nothing; switching chat models keeps the embedder.
    assert.deepEqual(unloads, [
      ["qwen-test", "embeddinggemma"],
      ["glm-test", "embeddinggemma"],
    ]);
  } finally {
    setProvider(before);
  }
});

test("summaries: points can be shown one by one while the JSON is still being written", async () => {
  assert.deepEqual(partialPoints('{"enough":true,"reason":"","points":[{"text":"Strong induction: assume P(1)…P(k)","concept":"strong'), ["Strong induction: assume P(1)…P(k)"]);
  assert.deepEqual(partialPoints('{"points":[{"text":"A \\"quoted\\" idea"},{"text":"half writ'), ['A "quoted" idea']);
  assert.deepEqual(partialPoints('{"enough":true,"rea'), []);

  const passages = [{ id: "p1", text: "word ".repeat(100), sourceTitle: "Notes" }];
  const reply = JSON.stringify({ enough: true, reason: "", points: [{ text: "First idea", concept: "a", sources: [1] }, { text: "Second idea", concept: "b", sources: [1] }] });
  const before = provider();
  setProvider(new MockProvider(() => reply));
  try {
    const seen: string[][] = [];
    const s = await summarizeSession(passages, "MATH 135", undefined, { model: "m" }, [], (points) => seen.push(points));
    assert.equal(s.ok && s.points.length, 2);
    assert.deepEqual(seen.at(-1), ["First idea", "Second idea"]);
  } finally {
    setProvider(before);
  }
});

test("privacy: only study apps on the list, and pictures with sensitive text, stay home", () => {
  assert.ok(isStudyApp("Google Chrome", DEFAULT_STUDY_APPS));
  assert.ok(isStudyApp("google chrome ", DEFAULT_STUDY_APPS));
  assert.ok(!isStudyApp("Messages", DEFAULT_STUDY_APPS));
  assert.ok(!isStudyApp("", DEFAULT_STUDY_APPS));
  assert.ok(allFromStudyApps(["Preview", "Safari"], DEFAULT_STUDY_APPS));
  assert.ok(!allFromStudyApps(["Preview", "Terminal"], DEFAULT_STUDY_APPS));
  assert.ok(allFromStudyApps([], DEFAULT_STUDY_APPS), "nothing to send is fine");
  assert.ok(looksSensitive("Password: hunter2"));
  assert.ok(looksSensitive("Card 4111 1111 1111 1111"));
  assert.ok(!looksSensitive("lim sin(n)/n = 0 by the squeeze theorem"));
  assert.deepEqual(cleanAppList(["Preview", " preview ", "", "  Notion  "]), ["Preview", "Notion"]);
  assert.deepEqual(cleanAppList(undefined), DEFAULT_STUDY_APPS);
});

test("keys: both Gemini key formats are accepted; anything that could break the Keychain command isn't", () => {
  assert.ok(looksLikeApiKey("AIzaSyD-made_up_0123456789abcdefghij")); // standard key (before May 2026)
  assert.ok(looksLikeApiKey("AQ.Ab8RN6Lmadeup-key_0123456789abcdefghijklmnop")); // auth key (AI Studio now)
  assert.ok(!looksLikeApiKey("short"));
  assert.ok(!looksLikeApiKey('AQ.Ab8RN6Lmadeup"; rm -rf ~; "0123456789'));
  assert.ok(!looksLikeApiKey("AQ.Ab8RN6L madeup 0123456789abcdefghij"));
  assert.ok(!looksLikeApiKey("AQ.Ab8RN6Lmadeup\\0123456789abcdefghij"));
});

test("settings: fast mode is on by default (it only works once a key is saved) and odd model names are refused", () => {
  const d = sanitizeSettings(DEFAULT_SETTINGS_FILE);
  assert.equal(d.cloud.enabled, true);
  assert.equal(d.cloud.model, "gemini-3.5-flash-lite");
  const odd = sanitizeSettings({ ...DEFAULT_SETTINGS_FILE, cloud: { enabled: false, model: "../../etc", studyApps: ["Preview"] } });
  assert.equal(odd.cloud.model, "gemini-3.5-flash-lite");
  assert.equal(odd.cloud.enabled, false);
  assert.deepEqual(odd.cloud.studyApps, ["Preview"]);
});
