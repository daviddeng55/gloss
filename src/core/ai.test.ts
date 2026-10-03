import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptRewrite, alignRewrites, ensureMathDelimiters, fixLatexEscapes, tooThin, validateQuestions } from "./ai.ts";
import { looksMathy, unionBox } from "./capture.ts";
import { StudyDb } from "./db.ts";

test("LaTeX backslashes survive JSON parsing", () => {
  const raw = String.raw`{"a":"$\frac{1}{2}$, \beta, \neq, \times, \rho, \theta","b":"line one\nThe next"}`;
  const out = JSON.parse(fixLatexEscapes(raw));
  assert.equal(out.a, String.raw`$\frac{1}{2}$, \beta, \neq, \times, \rho, \theta`);
  assert.equal(out.b, "line one\nThe next"); // a real line break stays a line break
  assert.equal(JSON.parse(fixLatexEscapes(String.raw`{"a":"\\frac"}`)).a, String.raw`\frac`); // already escaped
});

test("math pass swaps in corrected lines only when the words match", () => {
  const ocr = [
    "Proposition. For all n e N, 1 + 2 + ... + n=n(n+1)/2.",
    "Inductive step: assume P(k) holds for some k ≥ 1.",
    "Ifa bandb| c, then a | c.",
  ];
  // The model transcribed the image in its own order, with an extra title line.
  const model = [
    "MATH 135 — Lecture 7: Induction",
    "If $a \\mid b$ and $b \\mid c$, then $a \\mid c$.",
    "Proposition. For all $n \\in \\mathbb{N}$, $1 + 2 + \\cdots + n = n(n+1)/2$.",
  ];
  const r = alignRewrites(ocr, model);
  assert.equal(r.changed, 2);
  assert.equal(r.lines[0], model[2]);
  assert.equal(r.lines[1], ocr[1]); // no match: unchanged
  assert.equal(r.lines[2], model[1]);
});

test("math pass rejects rewrites that change the words", () => {
  assert.ok(!acceptRewrite("Base case: P(1) holds since 1 = 1(2)/2.", "Base case: P(0) is trivially true by definition of the empty sum."));
  assert.ok(!acceptRewrite("Then x is even.", "Then x is odd, and so y must be prime."));
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
