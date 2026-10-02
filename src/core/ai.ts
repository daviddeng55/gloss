// All AI calls go through this module. Default: a local model through Ollama (http://localhost:11434).
//   summarizeSession()  — what a session covered, in order, with sources
//   makeQuiz()          — 5–8 questions from a session's text, each tied to a passage
//   checkAnswer()       — marks a short answer against its source passage
//   transcribeMath()    — re-reads math-heavy lines from a screenshot (Apple's OCR mangles math)
//   askAboutImage()     — Stage 4
//   embed()             — Stage 5

export type AiConfig = { baseUrl: string; model: string };
export const DEFAULT_AI: AiConfig = { baseUrl: "http://localhost:11434", model: "qwen3.5:4b" };

/** Rules included in every prompt (PRD section 9). */
export const TUTOR_RULES = `You are a study partner for a university student. Rules:
- Use ONLY the provided course material. If something needed isn't there, say "This may not have been covered in your course yet."
- For CS 135 (Racket): only use language features and patterns that appear in the material.
- Never write a complete answer to a graded assignment or quiz question. Give a hint, explain the concept, or work a different, similar example.
- Default to the smallest helpful hint.
- For math: show algebra one step per line and write division as stacked fractions with LaTeX \\frac{a}{b}, not a/b. Write math in LaTeX between $...$.
- The material was read from the screen by text recognition and may contain misread symbols. If it is unclear or doesn't contain the answer, say so. Never make things up.`;

export class AiError extends Error {
  readonly code: "not-running" | "model-missing" | "bad-output" | "failed";
  constructor(code: AiError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type Message = { role: "system" | "user" | "assistant"; content: string; images?: string[] };

/** One chat call. With `schema`, the model must reply with JSON matching it, which we parse. */
async function chat<T = string>(
  cfg: AiConfig,
  req: { messages: Message[]; schema?: object; think?: boolean; temperature?: number; numCtx?: number; timeoutMs?: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(req.timeoutMs ?? 180_000),
      body: JSON.stringify({
        model: cfg.model,
        messages: req.messages,
        stream: false,
        think: req.think ?? false,
        format: req.schema,
        options: { temperature: req.temperature ?? 0.2, num_ctx: req.numCtx ?? 8192 },
      }),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new AiError("failed", "The AI model took too long to answer.");
    throw new AiError("not-running", "Ollama isn't running. Open the Ollama app, then try again.");
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 || /not found/i.test(text)) {
      throw new AiError("model-missing", `The AI model isn't downloaded. In a terminal, run: ollama pull ${cfg.model}`);
    }
    throw new AiError("failed", `Ollama error ${res.status}: ${text.slice(0, 200)}`);
  }
  const content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
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

/** Is Ollama running, and is the model downloaded? */
export async function checkAi(cfg: AiConfig = DEFAULT_AI): Promise<{ ok: true } | { ok: false; error: AiError }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tags = (await res.json()) as { models?: { name: string }[] };
    if (!tags.models?.some((m) => m.name === cfg.model)) {
      return { ok: false, error: new AiError("model-missing", `The AI model isn't downloaded. In a terminal, run: ollama pull ${cfg.model}`) };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: new AiError("not-running", "Ollama isn't running. Open the Ollama app, then try again.") };
  }
}

// ---------- session material ----------

export type Passage = { id: string; text: string; sourceTitle: string };

/** Numbered passages for a prompt, trimmed to fit: evenly sample if the session is very long. */
function numbered(passages: Passage[], maxChars: number): { text: string; used: Passage[] } {
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
  | { ok: true; points: { text: string; passageIds: string[] }[] }
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
        properties: { text: { type: "string" }, sources: { type: "array", items: { type: "integer" } } },
        required: ["text", "sources"],
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
): Promise<Summary> {
  const thin = tooThin(passages);
  if (thin) return { ok: false, reason: thin };
  const { text, used } = numbered(passages, 36_000);
  const out = await chat<{ enough: boolean; reason: string; points: { text: string; sources: number[] }[] }>(cfg, {
    numCtx: 16_384,
    schema: SUMMARY_SCHEMA,
    messages: [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        content: `Below are numbered passages of ${course} notes captured from the student's screen during one study session, in the order they were seen.${goal ? ` The student's goal was: "${goal}".` : ""}

List what the student covered, in order, as 3 to 8 short points (one sentence each, plain and specific, e.g. "Proof by strong induction: assume P(1)...P(k) to prove P(k+1)"). Each point must come from the passages; give the passage numbers it came from in "sources". Do not add anything that isn't in the passages. Ignore stray interface text (menus, buttons, ads).
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
        },
        required: ["type", "question", "answer", "source"],
      },
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
};

/** Keeps only well-formed questions. Exported for tests. */
export function validateQuestions(raw: RawQuestion[], used: Passage[]): QuizDraft[] {
  const out: QuizDraft[] = [];
  const seen = new Set<string>();
  for (const q of raw ?? []) {
    const question = q.question?.trim();
    if (!question || seen.has(question.toLowerCase())) continue;
    if (!(q.source >= 1 && q.source <= used.length)) continue;
    const passageId = used[q.source - 1].id;
    if (q.type === "multiple_choice") {
      const options = (q.options ?? []).map((o) => String(o).trim()).filter(Boolean);
      if (options.length < 3 || options.length > 5 || new Set(options).size !== options.length) continue;
      // The correct option: by index (0- or 1-based), else by matching the answer text.
      let idx = typeof q.correct_option === "number" ? q.correct_option : -1;
      if (!(idx >= 0 && idx < options.length) && idx === options.length) idx -= 1;
      const byText = options.findIndex((o) => o.toLowerCase() === q.answer?.trim().toLowerCase());
      if (byText >= 0) idx = byText;
      if (!(idx >= 0 && idx < options.length)) continue;
      out.push({ type: "multiple_choice", question, options, answer: options[idx], passageId });
    } else if (q.type === "short_answer") {
      const answer = q.answer?.trim();
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
  opts: { think?: boolean } = {},
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

Write a quiz of 6 questions (at least 2 "multiple_choice" and at least 2 "short_answer") that checks understanding of this material.
- Every question must be answerable from ONE passage alone; put its number in "source".
- Test ideas that matter (definitions, why a step works, what a result says), not trivia like page numbers or window titles.
- multiple_choice: 4 "options", exactly one correct; "correct_option" is its index starting at 0; "answer" is the correct option's text. Wrong options should be plausible.
- short_answer: a question with a short answer (a few words or one sentence); "answer" is the model answer taken from the passage.
- Write math in LaTeX between $...$.
- Ignore stray interface text and anything that looks garbled.
If the passages don't contain enough clear course material for good questions, set "enough" to false, explain in "reason", and return no questions. Otherwise "enough" is true and "reason" is "".

${text}`,
      },
    ],
  });
  if (!out.enough) return { ok: false, reason: out.reason || "The captured text wasn't clear enough to make good questions." };
  const questions = validateQuestions(out.questions, used);
  if (questions.length < 3) {
    return { ok: false, reason: "The AI couldn't make enough good questions from this session's text." };
  }
  return { ok: true, questions };
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

"correct" is true if the student's answer means the same as the model answer (wording, spelling and notation can differ; it may be less detailed but must not be wrong or missing the key idea).
"explanation": if correct, "". If not, 1–2 sentences, based on the passage, on what the right idea is and what was missing or wrong.`,
      },
    ],
  });
  return { correct: !!out.correct, explanation: out.correct ? "" : (out.explanation ?? "").trim() };
}

// ---------- math pass ----------

const MATH_SCHEMA = {
  type: "object",
  properties: { lines: { type: "array", items: { type: "string" } } },
  required: ["lines"],
};

/** Letters of a line with LaTeX commands removed, for checking a rewrite still says the same thing. */
export function letterSkeleton(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** How much two lines' letters agree, 0–1 (longest common subsequence over the longer one). */
export function letterAgreement(a: string, b: string): number {
  const x = letterSkeleton(a);
  const y = letterSkeleton(b);
  if (!x || !y) return x === y ? 1 : 0;
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

/** Accept a rewritten line only if its words still match the OCR line: symbols may change, words may not. */
export function acceptRewrite(original: string, rewritten: string): boolean {
  const short = letterSkeleton(original).length < 4;
  return letterAgreement(original, rewritten) >= (short ? 0.5 : 0.75);
}

/**
 * Pairs each OCR line with the transcribed line that has the same words, and swaps it in.
 * Lines with no good match stay as they were. Exported for tests.
 */
export function alignRewrites(ocrLines: string[], transcribed: string[]): { lines: string[]; changed: number } {
  const used = new Set<number>();
  let changed = 0;
  const lines = ocrLines.map((orig) => {
    let best = -1;
    let bestScore = 0;
    transcribed.forEach((t, j) => {
      if (used.has(j)) return;
      const score = letterAgreement(orig, t);
      if (score > bestScore) [best, bestScore] = [j, score];
    });
    if (best < 0 || !acceptRewrite(orig, transcribed[best])) return orig;
    used.add(best);
    const r = transcribed[best];
    if (r !== orig) changed++;
    return r;
  });
  return { lines, changed };
}

/**
 * Given a screenshot of the new math (JPEG/PNG, base64) and the lines Apple's OCR read from it, has the
 * model transcribe the image with proper math, then swaps in its version of each line whose words match.
 * The model can fix symbols but can't add content: unmatched or changed-meaning lines are ignored.
 */
export async function transcribeMath(
  imageBase64: string,
  lines: string[],
  cfg: AiConfig = DEFAULT_AI,
): Promise<{ lines: string[]; changed: number }> {
  const out = await chat<{ lines: string[] }>(cfg, {
    schema: MATH_SCHEMA,
    temperature: 0,
    timeoutMs: 90_000,
    messages: [
      {
        role: "user",
        images: [imageBase64],
        content: `Transcribe all text in this image exactly, one line of the image per line. Write math in LaTeX between $...$ (e.g. $x_{k+1} = 2x_k$, $\\sum_{i=1}^{n} i$, $\\sqrt{2}$, $n \\in \\mathbb{N}$, $\\frac{a}{b}$). Do not solve, explain or add anything. If a symbol is unclear, write [unclear].`,
      },
    ],
  });
  return alignRewrites(lines, (out.lines ?? []).map((l) => String(l).trim()).filter(Boolean));
}

// ---------- later stages ----------

export async function askAboutImage(): Promise<never> {
  throw new AiError("failed", "Hover-and-ask arrives in Stage 4.");
}

export async function embed(): Promise<never> {
  throw new AiError("failed", "Embeddings arrive in Stage 5.");
}
