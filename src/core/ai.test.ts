import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { alignParagraphs, ensureMathDelimiters, fixLatexEscapes, splitReading, tooThin, urgently, validateQuestions, withModel } from "./ai.ts";
import { looksMathy, unionBox } from "./capture.ts";
import { StudyDb } from "./db.ts";

test("LaTeX backslashes survive JSON parsing", () => {
  const raw = String.raw`{"a":"$\frac{1}{2}$, \beta, \neq, \times, \rho, \theta","b":"line one\nThe next"}`;
  const out = JSON.parse(fixLatexEscapes(raw));
  assert.equal(out.a, String.raw`$\frac{1}{2}$, \beta, \neq, \times, \rho, \theta`);
  assert.equal(out.b, "line one\nThe next"); // a real line break stays a line break
  assert.equal(JSON.parse(fixLatexEscapes(String.raw`{"a":"\\frac"}`)).a, String.raw`\frac`); // already escaped
});

// Real readings of the same typeset page: Apple's text recognition vs the math reader (GLM-OCR).
const APPLE = [
  "Example 4. Let A = {n E Z: 10 | n} and B = {n EZ: 2 | n}. Prove that A C Band B 4 A.",
  "We prove Vn E L, (n E A) → (n E B). Suppose n = 10k; then n = 2(5k), so n E B.",
  "The sum of the first n squares is",
  "[i=N(n + 1)(2n + 1)\nі=1",
  "and for x, y ≥ O we have \"-Y > Vxy, with equality iff x = y.",
  "By De Morgan, AU B= AnB, andxk+1= 2xk + 15xk-1 fork ≥ 2.",
];
const GLM = splitReading(String.raw`Example 4. Let $A = \{n \in \mathbb{Z}: 10 \mid n\}$ and $B = \{n \in \mathbb{Z}: 2 \mid n\}$. Prove that $A \subseteq B$ and $B \not\subseteq A$.

We prove $\forall n \in \mathbb{Z}, (n \in A) \Rightarrow (n \in B)$. Suppose $n = 10k$; then $n = 2(5k)$, so $n \in B$.

The sum of the first $n$ squares is

$$\sum_{i=1}^{n} i^{2} = \frac{n(n+1)(2n+1)}{6}$$

and for $x, y \geq 0$ we have $\frac{x+y}{2} \geq \sqrt{xy}$, with equality iff $x = y$.

By De Morgan, $\overline{A \cup B} = \overline{A} \cap \overline{B}$, and $x_{k+1} = 2x_{k} + 15x_{k-1}$ for $k \geq 2$.`);

test("math reading replaces each garbled paragraph with its correct version", () => {
  const all = APPLE.map((_, i) => i);
  const r = alignParagraphs(APPLE, all, GLM);
  assert.equal(r.paragraphs[0], GLM[0]);
  assert.equal(r.paragraphs[1], GLM[1]);
  assert.equal(r.paragraphs[4], GLM[4]);
  assert.equal(r.paragraphs[5], GLM[5]);
  assert.ok(r.changed >= 5, `changed ${r.changed}`);
  assert.ok(!r.paragraphs.includes("і=1"), "stray subscript fragment dropped");
});

test("math reading ignores text in the crop that wasn't new, and never invents paragraphs", () => {
  // Only paragraph 4 is new; the reading also contains the (already saved) paragraphs around it.
  const r = alignParagraphs(APPLE, [4], GLM);
  assert.deepEqual(r.paragraphs.filter((p, i) => p !== APPLE[i]), [GLM[4]]);
  // A reading that says something different is rejected.
  const wrong = alignParagraphs(["Then x is even, so y is odd."], [0], ["Therefore every prime greater than two is odd."]);
  assert.equal(wrong.changed, 0);
});

test("readings are split into lines without code fences or repeats", () => {
  assert.deepEqual(splitReading("```markdown\nA\n\nB\nA\n```"), ["A", "B"]);
  assert.deepEqual(splitReading("so $ n \\in B. $ and $$x$$"), ["so $n \\in B.$ and $$x$$"]);
});

test("quiz validation keeps well-formed questions and finds the right option", () => {
  const passages = [{ id: "p1", text: "t", sourceTitle: "" }, { id: "p2", text: "t", sourceTitle: "" }];
  const qs = validateQuestions(
    [
      { type: "multiple_choice", question: "Q1?", options: ["a", "b", "c", "d"], correct_option: 2, answer: "c", source: 1 },
      { type: "multiple_choice", question: "Q2?", options: ["a", "b", "c", "d"], correct_option: 9, answer: "b", source: 2 }, // bad index, answer text matches
      { type: "multiple_choice", question: "Q3?", options: ["a", "a", "c"], correct_option: 0, answer: "a", source: 1 }, // duplicate options
      { type: "short_answer", question: "Q4?", answer: "\\frac{1}{2}", source: 2 },
      { type: "short_answer", question: "Q5?", answer: "x", source: 7 }, // no such passage
      { type: "short_answer", question: "Q1?", answer: "dup", source: 1 }, // duplicate question
    ],
    passages,
  );
  assert.deepEqual(qs.map((q) => q.question), ["Q1?", "Q2?", "Q4?"]);
  assert.equal(qs[0].answer, "c");
  assert.equal(qs[1].answer, "b");
  assert.equal(qs[2].answer, "$\\frac{1}{2}$");
  assert.equal(qs[2].passageId, "p2");
});

test("questions that point at things you can't see are dropped", () => {
  const passages = [{ id: "p1", text: "t", sourceTitle: "" }];
  const qs = validateQuestions(
    [
      { type: "short_answer", question: "According to Passage [1], what is the limit of 1/2^n?", answer: "0", source: 1 },
      { type: "short_answer", question: "In Example 48, which sequences are compared?", answer: "x", source: 1 },
      { type: "short_answer", question: "What does Theorem 46 conclude?", answer: "x", source: 1 },
      { type: "short_answer", question: "If $a_n \\le b_n \\le c_n$ and both outer sequences tend to $L$, what is $\\lim b_n$?", answer: "$L$", source: 1 },
    ],
    passages,
  );
  assert.equal(qs.length, 1);
  assert.match(qs[0].question, /outer sequences/);
});

test("bare LaTeX gets $ delimiters, text with $ is left alone", () => {
  assert.equal(ensureMathDelimiters("\\sum_{i=1}^n i"), "$\\sum_{i=1}^n i$");
  assert.equal(ensureMathDelimiters("It is $\\frac{1}{2}$"), "It is $\\frac{1}{2}$");
  assert.equal(ensureMathDelimiters("plain"), "plain");
});

test("too little text is refused before calling the model", () => {
  assert.ok(tooThin([{ id: "a", text: "just a few words here", sourceTitle: "" }]));
  assert.equal(tooThin([{ id: "a", text: "word ".repeat(100), sourceTitle: "" }]), null);
});

test("math detection and crop box", () => {
  assert.ok(looksMathy("Xn=3xn-1+2Xn-2 (for n ≥3).\nThen for any positive integer n"));
  assert.ok(!looksMathy("The course notes were substantially revised in 2025.\nCourse notes will appear here"));
  const b = unionBox([{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, { x: 0.15, y: 0.5, w: 0.5, h: 0.1 }], 0);
  const want = { x: 0.1, y: 0.2, w: 0.55, h: 0.4 };
  for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(b[k] - want[k]) < 1e-9, k);
});

test("quiz answers update the score and spaced review", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  try {
    const db = new StudyDb(join(dir, "t.db"));
    const s = db.createSession({ courseId: "math135", startedAt: "2026-10-02T20:00:00.000Z" });
    const c = db.addChunk(s, "math135", { text: "passage", sourceApp: "Chrome", sourceTitle: "L11", capturedAt: "2026-10-02T20:01:00.000Z" });
    db.saveQuiz(s, "math135", [
      { type: "multiple_choice", question: "Q1", options: ["a", "b", "c"], answer: "b", passageId: c },
      { type: "short_answer", question: "Q2", answer: "x = y", passageId: c },
    ]);
    let items = db.getQuiz(s);
    assert.equal(items.length, 2);
    assert.equal(items[0].answered, undefined); // answer hidden until answered

    db.recordAnswer(items[0].id, { correct: true, response: "b", explanation: "", at: "2026-10-02T21:00:00.000Z" });
    db.recordAnswer(items[1].id, { correct: false, response: "x > y", explanation: "Equality holds when x = y.", at: "2026-10-02T21:01:00.000Z" });
    items = db.getQuiz(s);
    assert.deepEqual(items.map((q) => q.answered?.correct), [true, false]);
    assert.equal(items[1].answered?.explanation, "Equality holds when x = y.");
    assert.deepEqual(db.getSession(s)!.quizScore, { correct: 1, total: 2 });

    // Retrying a question doesn't change the session score (first answers count).
    db.recordAnswer(items[1].id, { correct: true, response: "x = y", explanation: "", at: "2026-10-02T21:02:00.000Z" });
    assert.deepEqual(db.getSession(s)!.quizScore, { correct: 1, total: 2 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a question you ask goes ahead of background AI work that is still waiting", async () => {
  const cfg = { model: "test" }; // tests use a pretend provider: nothing is loaded or unloaded
  const order: string[] = [];
  let release: (() => void) | undefined;
  const running = withModel(cfg, () => new Promise<void>((r) => (release = r)).then(() => void order.push("running")));
  const background = [1, 2].map((n) => withModel(cfg, async () => void order.push(`math re-read ${n}`)));
  const asked = urgently(() => withModel(cfg, async () => void order.push("question")));
  while (!release) await new Promise((r) => setTimeout(r, 5)); // the first job has started
  release();
  await Promise.all([running, ...background, asked]);
  assert.deepEqual(order, ["running", "question", "math re-read 1", "math re-read 2"]);
});
