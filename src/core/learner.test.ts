import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseHintLevel, conceptKey, conceptState, reviewIntervalDays, type Evidence } from "./learner.ts";

const t0 = Date.parse("2026-10-01T12:00:00Z");
const at = (days: number) => new Date(t0 + days * 86_400_000).toISOString();

test("studying gives some familiarity; correct answers raise mastery, wrong ones lower it", () => {
  const covered: Evidence[] = [{ at: at(0), kind: "covered" }];
  assert.equal(conceptState(covered, t0).current, 0.25);
  const right = conceptState([...covered, { at: at(0), kind: "quiz", correct: true }, { at: at(0), kind: "quiz", correct: true }], t0);
  const wrong = conceptState([...covered, { at: at(0), kind: "quiz", correct: false }], t0);
  assert.ok(right.current > 0.6, `right ${right.current}`);
  assert.ok(wrong.current < 0.25, `wrong ${wrong.current}`);
  assert.deepEqual(right.quizzes, { right: 2, wrong: 0 });
});

test("mastery fades without practice, and fades slower after correct answers", () => {
  const once: Evidence[] = [{ at: at(0), kind: "covered" }, { at: at(0), kind: "quiz", correct: true }];
  const fresh = conceptState(once, t0).current;
  const later = conceptState(once, t0 + 6 * 86_400_000).current;
  // One correct answer doubles the half-life from 3 to 6 days, so after 6 days it's exactly half.
  assert.ok(Math.abs(later - fresh / 2) < 1e-9, `fresh ${fresh}, later ${later}`);
  const thrice: Evidence[] = [...once, { at: at(0), kind: "quiz", correct: true }, { at: at(0), kind: "quiz", correct: true }];
  const laterStrong = conceptState(thrice, t0 + 6 * 86_400_000);
  assert.ok(laterStrong.current > later, "more correct answers = slower fading");
  assert.ok(laterStrong.why.some((w) => w.includes("faded")));
});

test("confidence grows with evidence; manual marks override", () => {
  const one = conceptState([{ at: at(0), kind: "quiz", correct: true }], t0);
  const five = conceptState(Array.from({ length: 5 }, () => ({ at: at(0), kind: "quiz" as const, correct: true })), t0);
  assert.ok(five.confidence > one.confidence);
  const known = conceptState([{ at: at(0), kind: "covered" }, { at: at(0), kind: "manual", correct: true }], t0);
  assert.ok(known.current >= 0.9);
  const unknown = conceptState([...Array.from({ length: 4 }, () => ({ at: at(0), kind: "quiz" as const, correct: true })), { at: at(1), kind: "manual", correct: false }], t0 + 86_400_000);
  assert.ok(unknown.current <= 0.15);
});

test("'what helps' credits the help you had before getting it right", () => {
  const ev: Evidence[] = [
    { at: at(0), kind: "covered" },
    { at: at(0), kind: "ask", hintLevel: "example" },
    { at: at(1), kind: "quiz", correct: true },
    { at: at(2), kind: "ask", hintLevel: "example" },
    { at: at(3), kind: "quiz", correct: true },
    { at: at(4), kind: "ask", hintLevel: "nudge" },
    { at: at(5), kind: "quiz", correct: false },
  ];
  assert.deepEqual(conceptState(ev, t0 + 5 * 86_400_000).helps, { nudge: 0, explain: 0, example: 2 });
});

test("choosing where to start: switch approach, use what helped, pitch by mastery", () => {
  const none = { nudge: 0, explain: 0, example: 0 };
  assert.equal(chooseHintLevel({ overall: none, lastLevelThisSession: "nudge" }).level, "explain");
  assert.equal(chooseHintLevel({ overall: none, lastLevelThisSession: "example" }).level, "example");
  const helped = conceptState([
    { at: at(0), kind: "ask", hintLevel: "example" }, { at: at(0), kind: "quiz", correct: true },
    { at: at(1), kind: "ask", hintLevel: "example" }, { at: at(1), kind: "quiz", correct: true },
  ], t0 + 86_400_000);
  assert.equal(chooseHintLevel({ concept: helped, overall: none }).level, "example");
  const weak = conceptState([{ at: at(0), kind: "quiz", correct: false }, { at: at(0), kind: "quiz", correct: false }], t0);
  assert.equal(chooseHintLevel({ concept: weak, overall: none }).level, "explain");
  assert.equal(chooseHintLevel({ overall: none }).level, "nudge");
  assert.equal(chooseHintLevel({ overall: { nudge: 0, explain: 3, example: 1 } }).level, "explain");
});

test("concept names are matched loosely", () => {
  assert.equal(conceptKey("Strong Induction."), conceptKey("strong induction"));
  assert.equal(conceptKey("Recursive sequences"), conceptKey("recursive sequence"));
  assert.notEqual(conceptKey("Sets"), conceptKey("Subsets"));
});

test("review intervals: 3, 7, 14 days; sooner for fading concepts; wrong = next session", () => {
  assert.equal(reviewIntervalDays(false, 7), 0);
  assert.equal(reviewIntervalDays(true, 0), 3);
  assert.equal(reviewIntervalDays(true, 3), 7);
  assert.equal(reviewIntervalDays(true, 14), 14);
  assert.equal(reviewIntervalDays(true, 3, 0.2), 4);
});
