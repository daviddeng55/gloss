// All AI calls go through this module. Default: a local model through Ollama (http://localhost:11434).
//   summarizeSession()  — what a session covered, in order, with sources
//   makeQuiz()          — 5–8 questions from a session's text, each tied to a passage
//   checkAnswer()       — marks a short answer against its source passage
//   transcribeMath()    — re-reads math-heavy lines from a screenshot (Apple's OCR mangles math)
//   askAboutImage()     — Stage 4
//   embed()             — Stage 5
// The calls themselves go through the active ModelProvider (provider.ts), so where the models run can change.

import { AsyncLocalStorage } from "node:async_hooks";
import { AiError, KEEP_ALIVE, provider, type ChatMessage } from "./provider.ts";

export { AiError, KEEP_ALIVE };

/** Which model a call uses (the provider decides where it runs). */
export type AiConfig = { model: string };
export const DEFAULT_AI: AiConfig = { model: "qwen3.5:4b" };

/** Rules included in every prompt (PRD section 9). */
export const TUTOR_RULES = `You are a study partner for a university student. Rules:
- Use ONLY the provided course material. If something needed isn't there, say "This may not have been covered in your course yet."
- For CS 135 (Racket): only use language features and patterns that appear in the material.
- Never write a complete answer to a graded assignment or quiz question. Give a hint, explain the concept, or work a different, similar example.
- Default to the smallest helpful hint.
- For math: show algebra one step per line and write division as stacked fractions with LaTeX \\frac{a}{b}, not a/b. Write math in LaTeX between $...$.
- The material was read from the screen by text recognition and may contain misread symbols. If it is unclear or doesn't contain the answer, say so. Never make things up.`;

type Message = ChatMessage;

// ---------- one model at a time ----------

type Job = { cfg: AiConfig; urgent: boolean; run: () => Promise<void> };
const waiting: Job[] = [];
let running = false;
let currentModel: string | null = null;
const urgentWork = new AsyncLocalStorage<boolean>();

/**
 * Runs AI work one request at a time, and never with two models in memory: switching to another
 * model first unloads the previous one. (A 16 GB fanless laptop can't comfortably hold both.)
 * Work started inside `urgently` goes ahead of background work that is still waiting.
 */
export function withModel<T>(cfg: AiConfig, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const urgent = urgentWork.getStore() === true;
    const job: Job = { cfg, urgent, run: () => Promise.resolve().then(work).then(resolve, reject) };
    // Urgent work waits only for earlier urgent work (and whatever is already running).
    const at = urgent ? waiting.findIndex((j) => !j.urgent) : -1;
    waiting.splice(at < 0 ? waiting.length : at, 0, job);
    void runWaiting();
  });
}

/**
 * AI calls made inside `work` jump ahead of background jobs such as math re-reads. Used when you
 * ask a question, so you aren't kept waiting behind the screen reader.
 */
export function urgently<T>(work: () => Promise<T>): Promise<T> {
  return urgentWork.run(true, work);
}

async function runWaiting() {
  if (running) return;
  running = true;
  while (waiting.length) {
    const job = waiting.shift()!;
    if (currentModel !== job.cfg.model) {
      await provider().unloadOthers(job.cfg.model).catch(() => {});
      currentModel = job.cfg.model;
    }
    await job.run();
  }
  running = false;
}

/** One chat call. With `schema`, the model must reply with JSON matching it, which we parse. */
export function chat<T = string>(
  cfg: AiConfig,
  req: { messages: Message[]; schema?: object; think?: boolean; temperature?: number; numCtx?: number; timeoutMs?: number },
): Promise<T> {
  return withModel(cfg, () => chatNow<T>(cfg, req));
}

async function chatNow<T>(
  cfg: AiConfig,
  req: { messages: Message[]; schema?: object; think?: boolean; temperature?: number; numCtx?: number; timeoutMs?: number },
): Promise<T> {
  const content = await provider().chat({ model: cfg.model, ...req });
  if (!req.schema) return content as T;
  try {
    return JSON.parse(fixLatexEscapes(content)) as T;
  } catch {
    throw new AiError("bad-output", "The AI model gave an answer in the wrong format.");
  }
}

/**
 * Models often write LaTeX like "\\frac" inside JSON with a single backslash, which JSON reads as an
 * escape ("\\f" = form feed) and silently eats. Double the backslash when it's clearly LaTeX.
 * Exported for tests.
 */
export function fixLatexEscapes(json: string): string {
  return json.replace(/(?<!\\)\\(?=(?:[bfrt][a-zA-Z]|n(?:eq|e\b|ot|u\b|abla|leq|geq|mid|subseteq|exists|i\b|ewline)))/g, "\\\\");
}

/** Is the AI available (Ollama running), and is the model downloaded? */
export async function checkAi(cfg: AiConfig = DEFAULT_AI): Promise<{ ok: true } | { ok: false; error: AiError }> {
  const models = await provider().models();
  if (!models) return { ok: false, error: new AiError("not-running", "Ollama isn't running. Open the Ollama app, then try again.") };
  if (!hasModel(models, cfg.model)) {
    return { ok: false, error: new AiError("model-missing", `The AI model isn't downloaded. In a terminal, run: ollama pull ${cfg.model}`) };
  }
  return { ok: true };
}

/** "embeddinggemma" is listed as "embeddinggemma:latest". */
function hasModel(models: string[], model: string): boolean {
  return models.some((m) => m === model || m === `${model}:latest`);
}

// ---------- session material ----------

export type Passage = { id: string; text: string; sourceTitle: string };

/** Numbered passages for a prompt, trimmed to fit: evenly sample if the session is very long. */
export function numbered(passages: Passage[], maxChars: number): { text: string; used: Passage[] } {
  let used = passages;
  const total = passages.reduce((n, p) => n + p.text.length, 0);
  if (total > maxChars) {
    const keep = Math.max(1, Math.floor((passages.length * maxChars) / total));
    used = Array.from({ length: keep }, (_, i) => passages[Math.floor((i * passages.length) / keep)]);
  }
  return {
    text: used.map((p, i) => `[${i + 1}] (from: ${p.sourceTitle || "unknown window"})\n${p.text}`).join("\n\n"),
    used,
  };
}

/** Too little text to say anything useful about. */
export function tooThin(passages: Passage[]): string | null {
  const words = passages.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0);
  return words < 80 ? `Only about ${words} words of notes were captured, which isn't enough to summarize or quiz on.` : null;
}

// ---------- summary ----------

export type Summary =
  | { ok: true; points: { text: string; passageIds: string[]; concept?: string }[] }
  | { ok: false; reason: string };

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    enough: { type: "boolean" },
    reason: { type: "string" },
    points: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          concept: { type: "string" },
          sources: { type: "array", items: { type: "integer" } },
        },
        required: ["text", "concept", "sources"],
      },
    },
  },
  required: ["enough", "reason", "points"],
};

export async function summarizeSession(
  passages: Passage[],
  course: string,
  goal: string | undefined,
  cfg: AiConfig = DEFAULT_AI,
  knownConcepts: string[] = [],
): Promise<Summary> {
  const thin = tooThin(passages);
  if (thin) return { ok: false, reason: thin };
  const { text, used } = numbered(passages, 36_000);
  const out = await chat<{ enough: boolean; reason: string; points: { text: string; concept?: string; sources: number[] }[] }>(cfg, {
    numCtx: 16_384,
    schema: SUMMARY_SCHEMA,
    messages: [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        content: `Below are numbered passages of ${course} notes captured from the student's screen during one study session, in the order they were seen.${goal ? ` The student's goal was: "${goal}".` : ""}

List what the student covered, in order, as 3 to 8 short points (one sentence each, plain and specific, e.g. "Proof by strong induction: assume P(1)...P(k) to prove P(k+1)"). Keep math short and simple; plain notation like (x+y)/2 or sqrt(xy) is fine. Each point must come from the passages; give the passage numbers it came from in "sources". Do not add anything that isn't in the passages. Ignore stray interface text (menus, buttons, ads) and anything that isn't study material (web searches, social media, email, unrelated sites) — leave those out entirely. Course material from a different course still counts: summarize it.
For each point also give "concept": the main idea it's about, as a short name (2–5 words, e.g. "strong induction", "limit of a recursive sequence").${knownConcepts.length ? ` Reuse one of these names from earlier sessions when it's the same idea: ${knownConcepts.slice(0, 80).map((c) => `"${c}"`).join(", ")}.` : ""}
If the passages are too garbled or unrelated to the course to summarize honestly, set "enough" to false, explain why in "reason", and return no points. Otherwise set "enough" to true and "reason" to "".

${text}`,
      },
    ],
  });
  if (!out.enough || !out.points?.length) {
    return { ok: false, reason: out.reason || "The captured text wasn't clear enough to summarize." };
  }
  return {
    ok: true,
    points: out.points
      .filter((p) => p.text?.trim())
      .slice(0, 8)
      .map((p) => ({
        text: p.text.trim(),
        concept: p.concept?.trim() || undefined,
        passageIds: [...new Set((p.sources ?? []).filter((n) => n >= 1 && n <= used.length).map((n) => used[n - 1].id))],
      })),
  };
}

// ---------- quiz ----------

export type QuizDraft = {
  type: "multiple_choice" | "short_answer";
  question: string;
  options?: string[];
  answer: string; // for multiple choice: the correct option's text
  passageId: string;
  conceptId?: string;
};

export type Quiz = { ok: true; questions: QuizDraft[] } | { ok: false; reason: string };

const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    enough: { type: "boolean" },
    reason: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["multiple_choice", "short_answer"] },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correct_option: { type: "integer" },
          answer: { type: "string" },
          source: { type: "integer" },
          concept: { type: "integer" },
        },
        required: ["type", "question", "answer", "source", "concept"],
      },
      minItems: 6,
      maxItems: 8,
    },
  },
  required: ["enough", "reason", "questions"],
};

type RawQuestion = {
  type: string;
  question: string;
  options?: string[];
  correct_option?: number;
  answer: string;
  source: number;
  concept?: number;
};

/** LaTeX written without $...$ won't display as math, so wrap it. Exported for tests. */
export function ensureMathDelimiters(text: string): string {
  return /\\[a-zA-Z]+/.test(text) && !text.includes("$") ? `$${text}$` : text;
}

/** Questions that only make sense if you can see the notes ("Passage [3]", "Example 48", "the table"). */
const NOT_SELF_CONTAINED = /\bpassages?\s*\[?\d|\[\d+\]|\b(example|theorem|exercise|problem|figure|table)\s+\d+|\bthe (table|passage|notes|text) (above|below|shown)/i;

/** Keeps only well-formed, self-contained questions. Exported for tests. */
export function validateQuestions(raw: RawQuestion[], used: Passage[]): QuizDraft[] {
  const out: QuizDraft[] = [];
  const seen = new Set<string>();
  for (const q of raw ?? []) {
    const question = ensureMathDelimiters(q.question?.trim() ?? "");
    if (!question || seen.has(question.toLowerCase())) continue;
    if (NOT_SELF_CONTAINED.test(question)) continue;
    if (!(q.source >= 1 && q.source <= used.length)) continue;
    const passageId = used[q.source - 1].id;
    if (q.type === "multiple_choice") {
      const options = (q.options ?? []).map((o) => ensureMathDelimiters(String(o).trim())).filter(Boolean);
      if (options.length < 3 || options.length > 5 || new Set(options).size !== options.length) continue;
      // The correct option: by index (0- or 1-based), else by matching the answer text.
      let idx = typeof q.correct_option === "number" ? q.correct_option : -1;
      if (!(idx >= 0 && idx < options.length) && idx === options.length) idx -= 1;
      const byText = options.findIndex((o) => o.toLowerCase() === ensureMathDelimiters(q.answer?.trim() ?? "").toLowerCase());
      if (byText >= 0) idx = byText;
      if (!(idx >= 0 && idx < options.length)) continue;
      out.push({ type: "multiple_choice", question, options, answer: options[idx], passageId });
    } else if (q.type === "short_answer") {
      const answer = ensureMathDelimiters(q.answer?.trim() ?? "");
      if (!answer) continue;
      out.push({ type: "short_answer", question, answer, passageId });
    } else continue;
    seen.add(question.toLowerCase());
  }
  return out.slice(0, 8);
}

export async function makeQuiz(
  passages: Passage[],
  course: string,
  cfg: AiConfig = DEFAULT_AI,
  opts: {
    think?: boolean;
    askedQuestions?: string[];
    /** This session's concepts with your current mastery (0–1), to aim at weak spots and pitch difficulty. */
    concepts?: { id: string; name: string; mastery: number }[];
  } = {},
): Promise<Quiz> {
  const thin = tooThin(passages);
  if (thin) return { ok: false, reason: thin };
  const { text, used } = numbered(passages, 30_000);
  const out = await chat<{ enough: boolean; reason: string; questions: RawQuestion[] }>(cfg, {
    numCtx: 16_384,
    temperature: 0.4,
    think: opts.think,
    timeoutMs: 300_000,
    schema: QUIZ_SCHEMA,
    messages: [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        content: `Below are numbered passages of ${course} notes the student studied in one session.

Write a quiz of 8 questions (at least 3 "multiple_choice" and at least 3 "short_answer") that checks understanding of this material.
- Every question must be answerable from ONE passage alone; put its number in "source".
- Every question must make sense on its own: never refer to "Example 48", "Theorem 46", "the table", "the notes" or "the passage" — state the formula, sequence or claim you're asking about in the question itself.
- Test ideas that matter (definitions, why a step works, what a result says), not trivia like page numbers or window titles.
- multiple_choice: 4 "options", exactly one correct; "correct_option" is its index starting at 0; "answer" is the correct option's text. Wrong options should be plausible.
- short_answer: a question with a short answer (a few words or one sentence); "answer" is the model answer taken from the passage.
- Write math in LaTeX between $...$.
${opts.concepts?.length ? `- Concepts in this session, with how well the student knows each (0–100%):\n${opts.concepts.map((c, i) => `  C${i + 1}. ${c.name}: ${Math.round(c.mastery * 100)}%`).join("\n")}\n  Put most questions on the weakest concepts. Pitch difficulty to mastery: below 40% ask about the basic idea or definition; 40–70% ask how or why a step works; above 70% ask something that needs applying it. Give each question's concept number in "concept" (e.g. 2 for C2).\n` : `- Set "concept" to 0.\n`}${opts.askedQuestions?.length ? `- During the session the student asked about: ${opts.askedQuestions.map((q) => `"${q.slice(0, 200)}"`).join("; ")}. Include at least 2 questions on those topics if the passages cover them.\n` : ""}- Ignore stray interface text, anything that looks garbled, and anything that isn't study material (web searches, social media, unrelated sites). Never ask about those.
If the passages don't contain enough clear course material for good questions, set "enough" to false, explain in "reason", and return no questions. Otherwise "enough" is true and "reason" is "".

${text}`,
      },
    ],
  });
  if (!out.enough) return { ok: false, reason: out.reason || "The captured text wasn't clear enough to make good questions." };
  const questions = validateQuestions(out.questions, used);
  // Attach each question's concept (by the number the model gave).
  const raw = out.questions ?? [];
  for (const q of questions) {
    const r = raw.find((x) => x.question?.trim() && ensureMathDelimiters(x.question.trim()) === q.question);
    const c = r?.concept;
    if (opts.concepts && typeof c === "number" && c >= 1 && c <= opts.concepts.length) q.conceptId = opts.concepts[c - 1].id;
  }
  if (questions.length < 3) {
    return { ok: false, reason: "The AI couldn't make enough good questions from this session's text." };
  }
  return { ok: true, questions };
}

// ---------- checking questions ----------

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { number: { type: "integer" }, keep: { type: "boolean" }, problem: { type: "string", maxLength: 120 } },
        required: ["number", "keep", "problem"],
      },
    },
  },
  required: ["results"],
};

/**
 * A second, stricter pass: the model checks each question against its source passage and we drop
 * any it can't fully support (wrong answer, unanswerable, nonsense, garbled). Small models write
 * plausible-looking but wrong questions, so this is how "never make things up" holds for quizzes.
 */
export async function verifyQuestions(
  questions: QuizDraft[],
  passages: Passage[],
  cfg: AiConfig = DEFAULT_AI,
): Promise<{ kept: QuizDraft[]; dropped: { question: string; problem: string }[] }> {
  // The cited passage plus its neighbours: a page often continues across two passages.
  const index = new Map(passages.map((p, i) => [p.id, i]));
  const context = (id: string) => {
    const i = index.get(id);
    if (i === undefined) return "";
    return passages.slice(Math.max(0, i - 1), i + 2).map((p) => p.text).join("\n\n");
  };
  const list = questions
    .map((q, i) => {
      const opts = q.options ? `\nOptions: ${q.options.map((o, j) => `(${j + 1}) ${o}`).join("  ")}` : "";
      return `### Question ${i + 1}\nPassage:\n${context(q.passageId)}\n\nQuestion: ${q.question}${opts}\nGiven answer: ${q.answer}`;
    })
    .join("\n\n");
  const out = await chat<{ results: { number: number; keep: boolean; problem: string }[] }>(cfg, {
    numCtx: 16_384,
    timeoutMs: 240_000,
    temperature: 0,
    schema: VERIFY_SCHEMA,
    messages: [
      {
        role: "user",
        content: `You are checking quiz questions written from course notes. For each question, set "keep" to true ONLY if all of these hold:
1. The question makes sense on its own and is clearly worded (it doesn't depend on seeing "Example N" or a table).
2. The passage alone contains what's needed to answer it.
3. The given answer is correct according to the passage (check any math carefully).
4. For multiple choice, exactly one option is correct.
Otherwise set "keep" to false. "problem": at most 15 words saying what's wrong ("" if kept). Don't explain your reasoning.
Return one result per question, with its number.

${list}`,
      },
    ],
  });
  const verdict = new Map((out.results ?? []).map((r) => [r.number, r]));
  const kept: QuizDraft[] = [];
  const dropped: { question: string; problem: string }[] = [];
  questions.forEach((q, i) => {
    const v = verdict.get(i + 1);
    if (v?.keep) kept.push(q);
    else dropped.push({ question: q.question, problem: v?.problem || "not checked" });
  });
  return { kept, dropped };
}

// ---------- marking ----------

export type Marking = { correct: boolean; explanation: string };

const MARK_SCHEMA = {
  type: "object",
  properties: { correct: { type: "boolean" }, explanation: { type: "string" } },
  required: ["correct", "explanation"],
};

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function checkAnswer(
  q: { question: string; answer: string },
  passage: string,
  studentAnswer: string,
  cfg: AiConfig = DEFAULT_AI,
): Promise<Marking> {
  if (!studentAnswer.trim()) return { correct: false, explanation: "No answer given." };
  if (normalize(studentAnswer) === normalize(q.answer)) return { correct: true, explanation: "" };
  const out = await chat<Marking>(cfg, {
    schema: MARK_SCHEMA,
    temperature: 0,
    messages: [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        content: `Mark a student's short answer using the course passage.

Passage:
${passage}

Question: ${q.question}
Model answer: ${q.answer}
Student's answer: ${studentAnswer}

"correct" is true if the student's answer means the same as the model answer (wording, spelling and notation can differ — e.g. "sqrt(x)", "x^2", "sum" or "a/b" typed instead of symbols; it may be less detailed but must not be wrong or missing the key idea).
"explanation": if correct, "". If not, 1–2 sentences, based on the passage, on what the right idea is and what was missing or wrong.`,
      },
    ],
  });
  return { correct: !!out.correct, explanation: out.correct ? "" : (out.explanation ?? "").trim() };
}

// ---------- math reading ----------

/**
 * Math courses use a small model made for reading documents (GLM-OCR, ~4 s per page section), because
 * Apple's text recognition can't read formulas. It returns Markdown with math as LaTeX ($...$).
 */
export const MATH_READER: AiConfig = { model: "glm-ocr:q8_0" };

/**
 * Reads an image (JPEG/PNG, base64) into lines of Markdown + LaTeX. The reply is streamed so we can stop
 * as soon as the model starts repeating itself (small OCR models sometimes loop).
 */
export function readMathImage(imageBase64: string, expectedChars: number, cfg: AiConfig = MATH_READER): Promise<string[]> {
  return withModel(cfg, () => readMathImageNow(imageBase64, expectedChars, cfg));
}

async function readMathImageNow(imageBase64: string, expectedChars: number, cfg: AiConfig): Promise<string[]> {
  let text = "";
  try {
    text = await provider().stream(
      {
        model: cfg.model,
        messages: [{ role: "user", content: "Text Recognition:", images: [imageBase64] }],
        temperature: 0,
        // LaTeX takes ~3 tokens per character of Apple's reading; the check below stops loops early.
        maxTokens: Math.min(3000, 200 + 3 * expectedChars),
        stop: ["```"],
        timeoutMs: 60_000,
      },
      (piece) => {
        text += piece;
        // A finished line we've already seen means the model is looping: stop here.
        const finished = text.split("\n").slice(0, -1).map((l) => l.trim()).filter(Boolean);
        if (finished.length) {
          const last = finished[finished.length - 1];
          if (last.length > 8 && finished.slice(0, -1).includes(last)) return false;
        }
      },
    );
  } catch (err) {
    if (err instanceof AiError && err.code !== "failed") throw err;
    // Too slow or cut off: keep what was read so far.
    if (!text) throw new AiError("failed", `Math reader failed: ${(err as Error).message}`);
  }
  return splitReading(text);
}

/**
 * Splits a reading into lines, dropping code fences and repeated lines (small OCR models sometimes
 * loop), and tidies inline math like "$ x $" to "$x$". Exported for tests.
 */
export function splitReading(content: string): string[] {
  const seen = new Set<string>();
  return content
    .replace(/```[a-z]*\n?/g, "")
    .split("\n")
    .map((l) => l.trim().replace(/(?<!\$)\$ +([^$\n]*?) *\$(?!\$)/g, (_m, inner: string) => `$${inner.trim()}$`))
    .filter((l) => {
      if (!l || seen.has(l)) return false;
      seen.add(l);
      return true;
    });
}

/**
 * Letters and digits of a text with LaTeX commands removed, for checking two readings say the same
 * thing. Digits count too, so lines that are mostly numbers (1^2 + 2^2 + ...) still compare well.
 */
export function letterSkeleton(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** How much two texts' letters and digits agree, 0–1 (longest common subsequence over the longer one). */
export function letterAgreement(a: string, b: string): number {
  const x = letterSkeleton(a);
  const y = letterSkeleton(b);
  if (!x || !y) return x === y ? 1 : 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length);
}

/**
 * Replaces Apple's reading of each paragraph in `which` with the math reader's version of the same
 * paragraph: a run of consecutive read lines whose letters match it. The strongest matches are taken
 * first, and each read line is used at most once. A paragraph is only replaced when the words agree,
 * so the reader can fix symbols but can't add text that wasn't on screen; read lines that match
 * nothing (e.g. old text in the crop) are ignored. Exported for tests.
 */
export function alignParagraphs(
  ocr: string[],
  which: number[],
  read: string[],
): { paragraphs: string[]; changed: number } {
  type Candidate = { i: number; start: number; len: number; score: number };
  const candidates: Candidate[] = [];
  for (const i of which) {
    const size = letterSkeleton(ocr[i]).length;
    const short = size < 15;
    const maxLen = ocr[i].split("\n").length + 2; // the reader may wrap lines differently
    for (let start = 0; start < read.length; start++) {
      for (let len = 1; len <= maxLen && start + len <= read.length; len++) {
        const run = read.slice(start, start + len).join("\n");
        const runSize = letterSkeleton(run).length;
        if (runSize > 2.5 * size + 10) break; // longer runs only get further off
        const score = letterAgreement(ocr[i], run);
        if (score >= (short ? 0.45 : 0.6)) candidates.push({ i, start, len, score });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const out = [...ocr];
  const doneParagraphs = new Set<number>();
  const usedLines = new Set<number>();
  let changed = 0;
  for (const c of candidates) {
    if (doneParagraphs.has(c.i)) continue;
    const lines = Array.from({ length: c.len }, (_, k) => c.start + k);
    if (lines.some((l) => usedLines.has(l))) continue;
    doneParagraphs.add(c.i);
    for (const l of lines) usedLines.add(l);
    const replacement = read.slice(c.start, c.start + c.len).join("\n");
    if (replacement !== ocr[c.i]) changed++;
    out[c.i] = replacement;
  }
  // Tiny leftovers Apple split off a formula (e.g. a subscript "i=1" on its own line) are dropped once
  // the reader has given us the whole formula.
  if (changed) {
    for (const i of which) {
      if (!doneParagraphs.has(i) && letterSkeleton(ocr[i]).length <= 4) out[i] = "";
    }
  }
  return { paragraphs: out.filter((p, i) => p !== "" || ocr[i] === ""), changed };
}

/** Re-reads the math paragraphs (indexes `which`) of a capture from its cropped screenshot. */
export async function readMathParagraphs(
  imageBase64: string,
  paragraphs: string[],
  which: number[],
  cfg: AiConfig = MATH_READER,
): Promise<{ paragraphs: string[]; changed: number }> {
  const chars = which.reduce((n, i) => n + paragraphs[i].length, 0);
  const read = await readMathImage(imageBase64, chars, cfg);
  return alignParagraphs(paragraphs, which, read);
}

// ---------- later stages ----------

// ---------- asking about what's on screen (Stage 4) ----------

export type HintLevel = "nudge" | "explain" | "example";

export const HINT_LEVELS: Record<HintLevel, { label: string; instruction: string }> = {
  nudge: {
    label: "Nudge",
    instruction:
      "Give the smallest helpful hint (1–3 sentences) that gets the student unstuck: point at what to look at or which idea applies. Don't solve it.",
  },
  explain: {
    label: "Explain the concept",
    instruction:
      "Explain the concept behind the question clearly and briefly, using the course material. Don't solve the student's specific problem.",
  },
  example: {
    label: "Worked example of a similar problem",
    instruction:
      "Work through a DIFFERENT but similar example, step by step (algebra one step per line). Do not solve the student's exact problem.",
  },
};

const STOP = new Set("the and for that this with what does from have how why can are was were when which into about there their then than your you this these those will would should could them they".split(" "));

/** The session passages that share the most words with the question (no embeddings until Stage 5). */
export function relevantPassages(question: string, passages: Passage[], max = 3, maxChars = 3000): Passage[] {
  const words = new Set(question.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? []);
  if (words.size === 0) return passages.slice(-max);
  const scored = passages
    .map((p, i) => {
      const text = p.text.toLowerCase();
      let score = 0;
      for (const w of words) if (text.includes(w)) score++;
      return { p, score, i };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i);
  const out: Passage[] = [];
  let chars = 0;
  for (const { p } of scored) {
    if (out.length >= max || chars + p.text.length > maxChars) break;
    out.push(p);
    chars += p.text.length;
  }
  return out;
}

/**
 * Answers a question about a cropped screenshot, at one hint level, streaming the answer through
 * `onText`. `earlier` holds previous turns about the same picture (for the hint ladder).
 */
export function askAboutImage(
  req: {
    imageBase64: string;
    question: string;
    course: string;
    level: HintLevel;
    passages: (Passage & { when?: string })[];
    earlier: { question: string; level: HintLevel; answer: string }[];
    /** What the learner model knows: the concept, how well it's known, related weak spots. */
    learner?: string;
  },
  onText: (text: string) => void,
  cfg: AiConfig = DEFAULT_AI,
): Promise<string> {
  return withModel(cfg, async () => {
    const material = req.passages.length
      ? req.passages.map((p, i) => `[${i + 1}] (${p.when ? `${p.when}, ` : ""}from: ${p.sourceTitle || "unknown window"})\n${p.text}`).join("\n\n")
      : "(Nothing from this session's notes matches this question.)";
    const messages: Message[] = [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        images: [req.imageBase64],
        content: `Course: ${req.course}. The image shows the part of the screen the student circled.

Course material (from this session and earlier ones):
${material}
${req.learner ? `\nAbout this student: ${req.learner}\n` : ""}

${req.earlier.length ? `Earlier in this conversation:\n${req.earlier.map((e) => `Q: ${e.question}\nYou (${HINT_LEVELS[e.level].label}): ${e.answer}`).join("\n\n")}\n\n` : ""}Student's question: ${req.question}

${HINT_LEVELS[req.level].instruction}
If the image looks like a graded assignment or quiz question, never give its final answer. If the course material doesn't cover what's needed, say "This may not have been covered in your course yet." If the image is unclear, say so. Use Markdown; write math in LaTeX between $...$.`,
      },
    ];
    return provider().stream({ model: cfg.model, messages, temperature: 0.3 }, (piece) => void onText(piece));
  });
}

// ---------- embeddings (course memory) ----------

/**
 * An embedding turns text into a list of numbers so that passages about the same idea end up close
 * together, even when they use different words. Used for searching your past sessions by meaning.
 */
export const EMBEDDER: AiConfig = { model: "embeddinggemma" };

/** Is the embedding model downloaded? (Without it, search falls back to matching words.) */
export async function embeddingsAvailable(cfg: AiConfig = EMBEDDER): Promise<boolean> {
  const models = await provider().models();
  return !!models && hasModel(models, cfg.model);
}

/**
 * `as` says what the text is: embeddinggemma matches better when a search question and the notes it
 * should find are labelled differently (its documented prompt format).
 */
export function embed(texts: string[], as: "query" | "document" = "document", cfg: AiConfig = EMBEDDER): Promise<number[][]> {
  const prefix = as === "query" ? "task: search result | query: " : "title: none | text: ";
  return withModel(cfg, () => provider().embed(cfg.model, texts.map((t) => prefix + t.slice(0, 4000))));
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}
