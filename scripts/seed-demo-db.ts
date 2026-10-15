// Fills a NEW database with made-up study sessions, for screenshots and design checks. No real data.
// Run: node scripts/seed-demo-db.ts <path/to/demo.db>   (refuses to touch an existing file)
import { existsSync } from "node:fs";
import { StudyDb } from "../src/core/db.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/seed-demo-db.ts <path/to/new.db>");
if (existsSync(path)) throw new Error(`${path} already exists; give a new file name.`);
const db = new StudyDb(path);

const day = (d: string, t: string) => new Date(`2026-10-${d}T${t}:00`).toISOString();
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

function session(courseId: string, start: string, minutes: number, goal: string, passages: { title: string; app?: string; text: string }[]) {
  const id = db.createSession({ courseId, goal, startedAt: start });
  const chunks = passages.map((p, i) =>
    db.addChunk(id, courseId, { text: p.text, sourceApp: p.app ?? "Google Chrome", sourceTitle: p.title, capturedAt: plus(start, 4 + i * 9) }),
  );
  db.endSession(id, { endedAt: plus(start, minutes + 3), activeMs: minutes * 60_000, stats: {} });
  return { id, chunks };
}

// ---------- MATH 135: strong induction (the main demo session) ----------
const lecture = "Lecture 11 - Strong Induction - MATH 135";
const induction = session("math135", day("13", "19:05"), 48, "Strong induction practice", [
  {
    title: lecture,
    text: "Principle of Strong Induction (POSI)\nLet P(n) be an open sentence that depends on n ∈ ℕ.\nIf P(1) is true, and for every k ∈ ℕ, P(1) ∧ P(2) ∧ … ∧ P(k) implies P(k + 1),\nthen P(n) is true for all n ∈ ℕ.",
  },
  {
    title: lecture,
    text: "Example. The Fibonacci numbers are f₁ = 1, f₂ = 1 and fₙ = fₙ₋₁ + fₙ₋₂ for n ≥ 3.\nProve that fₙ < 2ⁿ for all n ∈ ℕ.\nWe need two base cases, because the inductive step uses the two previous terms.",
  },
  {
    title: lecture,
    text: "Inductive step: assume fᵢ < 2ⁱ for all 1 ≤ i ≤ k, where k ≥ 2.\nThen fₖ₊₁ = fₖ + fₖ₋₁ < 2ᵏ + 2ᵏ⁻¹ < 2ᵏ + 2ᵏ = 2ᵏ⁺¹.\nSo the statement holds for k + 1.",
  },
  {
    title: "Strong induction - practice problems",
    text: "Problem 3. Every integer n ≥ 2 can be written as a product of primes.\nHint: if n is not prime, write n = ab with 1 < a, b < n and use the inductive hypothesis on both a and b.",
  },
]);
db.saveSummary(induction.id, {
  ok: true,
  points: [
    { text: "Strong induction lets you assume P(1), P(2), …, P(k) all hold when proving P(k+1), not just P(k).", passageIds: [induction.chunks[0]], concept: "Strong induction" },
    { text: "When the inductive step uses the two previous terms, you need two base cases (here f_1 and f_2).", passageIds: [induction.chunks[1]], concept: "Base cases" },
    { text: "The Fibonacci bound follows from f_(k+1) = f_k + f_(k-1) < 2^k + 2^(k-1) < 2^(k+1).", passageIds: [induction.chunks[1], induction.chunks[2]], concept: "Fibonacci bound" },
    { text: "Every integer n ≥ 2 is a product of primes: split a composite n = ab and apply the hypothesis to both factors.", passageIds: [induction.chunks[3]], concept: "Prime factorization" },
  ],
});
db.saveQuiz(induction.id, "math135", [
  {
    type: "multiple_choice",
    question: "In strong induction, what may you assume when proving $P(k+1)$?",
    options: ["Only $P(k)$", "$P(1), P(2), \\dots, P(k)$ all hold", "$P(k+1)$ itself", "Nothing beyond the base case"],
    answer: "$P(1), P(2), \\dots, P(k)$ all hold",
    passageId: induction.chunks[0],
  },
  {
    type: "short_answer",
    question: "Why does the proof that $f_n < 2^n$ need two base cases?",
    answer: "Because the inductive step uses both $f_k$ and $f_{k-1}$.",
    passageId: induction.chunks[1],
  },
  {
    type: "multiple_choice",
    question: "Which inequality finishes the inductive step for the Fibonacci bound?",
    options: ["$2^k + 2^{k-1} < 2^{k+1}$", "$2^k \\cdot 2^{k-1} < 2^{k+1}$", "$f_k < f_{k-1}$", "$2^{k+1} < 2^k$"],
    answer: "$2^k + 2^{k-1} < 2^{k+1}$",
    passageId: induction.chunks[2],
  },
  {
    type: "multiple_choice",
    question: "To show every $n \\ge 2$ is a product of primes, what do you do when $n$ is composite?",
    options: ["Write $n = ab$ with $1 < a, b < n$ and use the hypothesis on $a$ and $b$", "Divide $n$ by 2", "Assume $n$ is prime", "Use only the base case $n = 2$"],
    answer: "Write $n = ab$ with $1 < a, b < n$ and use the hypothesis on $a$ and $b$",
    passageId: induction.chunks[3],
  },
  {
    type: "short_answer",
    question: "State the Principle of Strong Induction in your own words.",
    answer: "If $P(1)$ holds and $P(1) \\land \\dots \\land P(k)$ implies $P(k+1)$ for every $k$, then $P(n)$ holds for all $n$.",
    passageId: induction.chunks[0],
  },
]);
const quiz = db.getQuiz(induction.id);
db.recordAnswer(quiz[0].id, { correct: true, response: quiz[0].options![1], explanation: "", at: day("13", "20:00") });
db.recordAnswer(quiz[1].id, {
  correct: false,
  response: "Because Fibonacci starts at 1.",
  explanation: "The step from $k$ to $k+1$ uses **two** earlier terms, $f_k$ and $f_{k-1}$, so both $f_1$ and $f_2$ must be checked directly.",
  at: day("13", "20:01"),
});

const q = db.addQuestion(induction.id, "math135", "Why can't we use ordinary induction for the Fibonacci bound?", lecture);
db.addAnswer(q, "Nudge", "Look at what the inductive step needs: does knowing only $f_k < 2^k$ tell you anything about $f_{k+1}$?");

// ---------- MATH 135: an earlier session ----------
const sets = session("math135", day("12", "15:30"), 32, "Set builder notation", [
  { title: "Lecture 9 - Sets - MATH 135", text: "A set is a collection of objects. S = {x ∈ ℤ : x is even}.\nTwo sets are equal when each is a subset of the other: S = T ⟺ S ⊆ T and T ⊆ S." },
  { title: "Lecture 9 - Sets - MATH 135", text: "To prove S ⊆ T, let x ∈ S be arbitrary and show x ∈ T." },
]);
db.saveSummary(sets.id, {
  ok: true,
  points: [
    { text: "Two sets are equal exactly when each is a subset of the other.", passageIds: [sets.chunks[0]], concept: "Set equality" },
    { text: "To prove S ⊆ T, take an arbitrary x ∈ S and show x ∈ T.", passageIds: [sets.chunks[1]], concept: "Subset proofs" },
  ],
});
db.saveQuiz(sets.id, "math135", [
  {
    type: "multiple_choice",
    question: "How do you prove two sets $S$ and $T$ are equal?",
    options: ["Show $S \\subseteq T$ and $T \\subseteq S$", "Show they have the same size", "Find one common element", "Show $S \\cap T$ is empty"],
    answer: "Show $S \\subseteq T$ and $T \\subseteq S$",
    passageId: sets.chunks[0],
  },
]);
// Answered wrong a while ago, so it's due for review (shows up in the warm-up).
const setQuiz = db.getQuiz(sets.id);
db.recordAnswer(setQuiz[0].id, { correct: false, response: "Show they have the same size", explanation: "Equal size isn't enough: {1} and {2} have the same size.", at: day("12", "16:10") });

// ---------- CS 135 ----------
const racket = session("cs135", day("11", "10:15"), 25, "", [
  { title: "Module 5 - Lists - CS 135", text: "A list is either empty or (cons v lst), where v is a value and lst is a list.\n(first (cons 1 empty)) ⇒ 1" },
]);
db.saveSummary(racket.id, { ok: true, points: [{ text: "A list is either empty or (cons v lst).", passageIds: [racket.chunks[0]], concept: "Lists" }] });
db.saveQuizNote(racket.id, "Too little material for a quiz.");

// ---------- Learner model: concepts with evidence ----------
const evidence: [string, string, { at: string; kind: "covered" | "quiz" | "ask"; correct?: boolean; sessionId: string }[]][] = [
  ["math135", "Strong induction", [{ at: day("13", "19:30"), kind: "covered", sessionId: induction.id }, { at: day("13", "20:00"), kind: "quiz", correct: true, sessionId: induction.id }]],
  ["math135", "Base cases", [{ at: day("13", "19:40"), kind: "covered", sessionId: induction.id }, { at: day("13", "20:01"), kind: "quiz", correct: false, sessionId: induction.id }]],
  ["math135", "Fibonacci bound", [{ at: day("13", "19:45"), kind: "covered", sessionId: induction.id }, { at: day("13", "19:50"), kind: "ask", sessionId: induction.id }]],
  ["math135", "Set equality", [{ at: day("12", "15:40"), kind: "covered", sessionId: sets.id }, { at: day("12", "16:10"), kind: "quiz", correct: false, sessionId: sets.id }]],
  ["math135", "Subset proofs", [{ at: day("12", "15:50"), kind: "covered", sessionId: sets.id }, { at: day("12", "16:12"), kind: "quiz", correct: true, sessionId: sets.id }, { at: day("13", "19:20"), kind: "quiz", correct: true, sessionId: induction.id }]],
  ["cs135", "Lists", [{ at: day("11", "10:30"), kind: "covered", sessionId: racket.id }]],
];
for (const [courseId, name, evs] of evidence) {
  const id = db.upsertConcept(courseId, name);
  const s = evs[0].sessionId;
  const chunk = s === induction.id ? induction.chunks[0] : s === sets.id ? sets.chunks[0] : racket.chunks[0];
  db.linkConcept(id, chunk, s);
  for (const e of evs) db.addEvidence(id, { ...e, hintLevel: e.kind === "ask" ? "nudge" : undefined });
}

db.close();
console.log(`Demo database written to ${path}`);
