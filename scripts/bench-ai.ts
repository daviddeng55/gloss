// Times the AI the way the app uses it: a session summary and a circle-and-ask question, through the real
// code paths (ai.ts, the learner's note search). For each it reports load time (a local model being loaded
// into memory), time to the first word, and total time.
//
//   node scripts/bench-ai.ts <copy-of-gloss.db> [--cloud] [--session <id>] [--out <file.json>] [--label <name>]
//
// --cloud uses fast mode (Gemini, with the key saved in Settings → Keychain; the key is never printed).
//
// Always run it on a COPY of the database (it saves concepts like the app does). Don't run it while Gloss
// is recording a session: it would compete with the app for the model.
import { readFileSync, writeFileSync } from "node:fs";
import { askAboutImage, DEFAULT_AI, setCloud, summarizeSession, urgently } from "../src/core/ai.ts";
import { StudyDb } from "../src/core/db.ts";
import { readApiKey } from "../src/core/keychain.ts";
import { GeminiProvider, KEEP_ALIVE, OllamaProvider, provider, setProvider, type ChatRequest, type ModelProvider } from "../src/core/provider.ts";
import { loadSettings } from "../src/core/settings.ts";
import { LearnerService } from "../src/main/learner.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = args.find((a) => a.endsWith(".db"));
if (!dbPath) throw new Error("Give the path to a copy of gloss.db");
const OLLAMA = "http://localhost:11434";

/** Every model call, with where its time went. */
type Call = { where: string; model: string; startedAt: number; loadMs: number; firstMs: number | null; totalMs: number };
const calls: Call[] = [];

async function loaded(): Promise<string[]> {
  const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models?: { name: string }[] };
  return (ps.models ?? []).map((m) => m.name);
}

async function unloadAll() {
  for (const name of await loaded()) {
    await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: name, keep_alive: 0 }) });
  }
  for (let i = 0; i < 50 && (await loaded()).length; i++) await new Promise((r) => setTimeout(r, 200));
}

/** Loads a local model without asking it anything; returns how long that took. */
async function load(model: string): Promise<number> {
  const names = await loaded();
  if (names.includes(model) || names.includes(`${model}:latest`)) return 0;
  const t = performance.now();
  await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: KEEP_ALIVE }) });
  return performance.now() - t;
}

/**
 * Wraps a provider to time each call. Local models are loaded explicitly first, so loading is measured on
 * its own; chat() is streamed so the first word can be timed (the app gets the same reply).
 */
class Timed implements ModelProvider {
  readonly name: string;
  private inner: ModelProvider;
  private local: boolean;
  constructor(inner: ModelProvider) {
    this.inner = inner;
    this.name = inner.name;
    this.local = inner instanceof OllamaProvider;
  }
  async stream(req: ChatRequest, onText: (piece: string) => boolean | void): Promise<string> {
    const startedAt = performance.now();
    const loadMs = this.local ? await load(req.model) : 0;
    const t = performance.now();
    let firstMs: number | null = null;
    const text = await this.inner.stream(req, (piece) => {
      firstMs ??= performance.now() - t;
      return onText(piece);
    });
    calls.push({ where: this.name, model: req.model, startedAt, loadMs, firstMs, totalMs: performance.now() - t });
    return text;
  }
  chat(req: ChatRequest): Promise<string> {
    return this.stream(req, () => {});
  }
  async embed(model: string, inputs: string[]): Promise<number[][]> {
    const startedAt = performance.now();
    const loadMs = this.local ? await load(model) : 0;
    const t = performance.now();
    const out = await this.inner.embed(model, inputs);
    calls.push({ where: this.name, model, startedAt, loadMs, firstMs: null, totalMs: performance.now() - t });
    return out;
  }
  models() {
    return this.inner.models();
  }
  unloadOthers(keep: string[]) {
    return this.inner.unloadOthers(keep);
  }
  async load(model: string) {
    await load(model);
  }
}

const db = new StudyDb(dbPath);
const courses = JSON.parse(readFileSync(new URL("../courses.json", import.meta.url), "utf8")) as { id: string; name: string }[];
const learner = new LearnerService(db, () => courses);
setProvider(new Timed(provider()));
const useCloud = args.includes("--cloud");
if (useCloud) {
  const key = await readApiKey();
  if (!key) throw new Error("No Gemini key in the Keychain: save one in Gloss → Settings → Fast mode first.");
  setCloud({ provider: new Timed(new GeminiProvider(key)), model: loadSettings(new URL("../settings.json", import.meta.url).pathname).cloud.model });
}

// A typical session: the one with the most text among those with 10–20 passages, unless one is given.
const sessions = db.listSessions().filter((s) => s.endedAt);
// The warm summary uses a second session: the same text twice would let Ollama reuse its cached prompt.
const typical = [...sessions].filter((s) => s.chunkCount >= 10 && s.chunkCount <= 20).sort((a, b) => b.charCount - a.charCount);
const session = sessions.find((s) => s.id === opt("session")) ?? typical[0];
const second = typical.find((s) => s.id !== session?.id && s.courseId === session?.courseId) ?? session;
if (!session) throw new Error("No suitable session in this database");
const courseName = courses.find((c) => c.id === session.courseId)?.name ?? session.courseId;
const passages = db.getPassages(session.id);
const image = readFileSync(new URL("./bench-crop.jpg", import.meta.url)).toString("base64");
const cfg = { ...DEFAULT_AI, cloud: useCloud };

type Result = {
  task: string;
  start: "cold" | "warm";
  firstWordMs: number | null;
  totalMs: number;
  loadMs: number;
  calls: number;
  where: string[];
  detail: { where: string; model: string; atMs: number; loadMs: number; firstMs: number | null; totalMs: number }[];
};
const results: Result[] = [];

/** Runs `work`, then reports the model calls it made. */
async function measure(task: string, start: "cold" | "warm", work: (onFirst: () => void) => Promise<unknown>) {
  if (start === "cold") await unloadAll();
  else await load(cfg.model);
  const from = calls.length;
  const t0 = performance.now();
  let first: number | null = null;
  await work(() => (first ??= performance.now() - t0));
  const totalMs = performance.now() - t0;
  const mine = calls.slice(from);
  // Without a word-by-word callback (summaries), the first word is the first piece of the last call.
  const last = mine[mine.length - 1];
  const firstWordMs = first ?? (last?.firstMs != null ? last.startedAt - t0 + last.loadMs + last.firstMs : null);
  const r: Result = {
    task,
    start,
    firstWordMs: firstWordMs === null ? null : Math.round(firstWordMs),
    totalMs: Math.round(totalMs),
    loadMs: Math.round(mine.reduce((n, c) => n + c.loadMs, 0)),
    calls: mine.length,
    where: [...new Set(mine.map((c) => `${c.where}:${c.model}`))],
    detail: mine.map((c) => ({
      where: c.where,
      model: c.model,
      atMs: Math.round(c.startedAt - t0),
      loadMs: Math.round(c.loadMs),
      firstMs: c.firstMs === null ? null : Math.round(c.firstMs),
      totalMs: Math.round(c.totalMs),
    })),
  };
  results.push(r);
  const s = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
  console.log(`${task.padEnd(8)} ${start.padEnd(5)} load ${s(r.loadMs).padStart(7)}  first word ${s(r.firstWordMs).padStart(7)}  total ${s(r.totalMs).padStart(7)}  (${r.calls} calls: ${r.where.join(", ")})`);
}

const summary = (s: typeof session) => () =>
  summarizeSession(db.getPassages(s.id), courseName, s.goal, cfg, learner.knownConceptNames(s.courseId));

/** As in ask.ts: find the concept and related notes, then answer about the picture, word by word. */
const ask = (question: string) => (onFirst: () => void) =>
  urgently(async () => {
    const concept = await learner.conceptForQuestion(session.courseId, question).catch(() => null);
    const found = await learner.passagesFor(session.courseId, session.id, question);
    const note = learner.learnerNote(concept?.id ?? null, []);
    return askAboutImage(
      { imageBase64: image, question, course: courseName, level: "nudge", passages: found, earlier: [], learner: note },
      () => onFirst(),
      cfg,
    );
  });

console.log(`Session ${session.id.slice(0, 8)} (${courseName}): ${passages.length} passages, ${session.charCount} characters`);
console.log(`Warm summary on ${second.id.slice(0, 8)}: ${second.chunkCount} passages, ${second.charCount} characters\n`);
await measure("summary", "cold", summary(session));
await measure("summary", "warm", summary(second));
await measure("ask", "cold", ask("why does dividing by n keep the inequality the same?"));
await measure("ask", "warm", ask("how do I know which two sequences to squeeze with?"));
await measure("ask", "warm", ask("what does the squeeze theorem say?"));

const out = opt("out");
if (out) {
  writeFileSync(out, JSON.stringify({ label: opt("label") ?? "", at: new Date().toISOString(), session: session.id, passages: passages.length, second: second.id, results }, null, 2) + "\n");
  console.log(`\nSaved ${out}`);
}
