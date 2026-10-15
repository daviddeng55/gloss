import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { chat, checkAi, embed } from "./ai.ts";
import { AiError, MockProvider, OllamaProvider, provider, setProvider } from "./provider.ts";

/** A pretend Ollama on a random local port (the real one is never contacted). */
async function fakeOllama(handle: (path: string, body: any, res: import("node:http").ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => handle(req.url ?? "", raw ? JSON.parse(raw) : null, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("tests use a pretend provider by default, never Ollama", () => {
  assert.equal(provider().name, "mock");
});

test("Ollama provider: sends the request Ollama expects and returns the reply", async () => {
  let seen: any;
  const { url, server } = await fakeOllama((_path, body, res) => {
    seen = body;
    res.end(JSON.stringify({ message: { content: '{"ok":true}' } }));
  });
  try {
    const p = new OllamaProvider(url);
    const out = await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], schema: { type: "object" }, maxTokens: 50 });
    assert.equal(out, '{"ok":true}');
    assert.equal(seen.model, "m");
    assert.equal(seen.stream, false);
    assert.equal(seen.keep_alive, "3m");
    assert.deepEqual(seen.format, { type: "object" });
    assert.equal(seen.options.num_predict, 50);
  } finally {
    server.close();
  }
});

test("Ollama provider: streams pieces and can stop early", async () => {
  const { url, server } = await fakeOllama((_path, _body, res) => {
    for (const piece of ["one ", "two ", "three ", "four"]) res.write(JSON.stringify({ message: { content: piece } }) + "\n");
    res.end(JSON.stringify({ done: true }) + "\n");
  });
  try {
    const p = new OllamaProvider(url);
    const pieces: string[] = [];
    assert.equal(await p.stream({ model: "m", messages: [] }, (t) => void pieces.push(t)), "one two three four");
    assert.equal(pieces.length, 4);
    const early = await p.stream({ model: "m", messages: [] }, (t) => t !== "two ");
    assert.equal(early, "one two ");
  } finally {
    server.close();
  }
});

test("Ollama provider: a missing model and a stopped Ollama give clear errors", async () => {
  const { url, server } = await fakeOllama((_path, _body, res) => {
    res.statusCode = 404;
    res.end('{"error":"model \\"m\\" not found"}');
  });
  try {
    await assert.rejects(new OllamaProvider(url).chat({ model: "m", messages: [] }), (e: AiError) => e.code === "model-missing");
  } finally {
    server.close();
  }
  // Port 9 (discard): nothing listens there.
  await assert.rejects(new OllamaProvider("http://127.0.0.1:9").chat({ model: "m", messages: [] }), (e: AiError) => e.code === "not-running");
  assert.equal(await new OllamaProvider("http://127.0.0.1:9").models(), null);
});

test("ai.ts calls go through whichever provider is active", async () => {
  const before = provider();
  const mock = new MockProvider((req) => (req.schema ? '{"answer":"$\\frac{1}{2}$"}' : "plain"), ["qwen3.5:4b", "embeddinggemma:latest"]);
  setProvider(mock);
  try {
    assert.equal(await chat({ model: "x" }, { messages: [{ role: "user", content: "q" }] }), "plain");
    const json = await chat<{ answer: string }>({ model: "x" }, { messages: [], schema: {} });
    assert.equal(json.answer, "$\\frac{1}{2}$"); // LaTeX survives JSON
    assert.equal(mock.calls.length, 2);
    assert.deepEqual(await checkAi({ model: "qwen3.5:4b" }), { ok: true });
    assert.equal((await checkAi({ model: "other" })).ok, false);
    assert.equal((await embed(["a", "b"])).length, 2);
  } finally {
    setProvider(before);
  }
});
