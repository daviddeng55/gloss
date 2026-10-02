import assert from "node:assert/strict";
import { test } from "node:test";
import { TextCleaner, groupLines, isNoiseLine } from "./clean.ts";
import type { TextBlock } from "./helper.ts";
import { redact } from "./redact.ts";

const block = (text: string, y = 0.3, x = 0.1, h = 0.03, confidence = 0.9): TextBlock => ({
  text,
  confidence,
  box: { x, y, w: 0.5, h },
});

test("drops UI noise but keeps short math", () => {
  for (const s of ["File", "Edit", "Share", "12:45 PM", "87%", "•", "learn.uwaterloo.ca/d2l/home", "Sign in"]) {
    assert.ok(isNoiseLine(s), s);
  }
  for (const s of ["x = 1", "Proof.", "a | b", "n(n+1)/2", "Lecture 7: Induction"]) {
    assert.ok(!isNoiseLine(s), s);
  }
});

test("drops text seen in an earlier capture, including OCR jitter", () => {
  const c = new TextCleaner({ engine: "document", mode: "window", minConfidence: 0.35 });
  const first = c.clean([block("Proposition. For all n in N, 1 + 2 + ... + n = n(n+1)/2.")]);
  assert.equal(first.paragraphs.length, 1);
  const again = c.clean([block("Proposition. For all n in N, 1+2+...+n=n(n+1)/2")]);
  assert.equal(again.paragraphs.length, 0);
  const nearly = c.clean([block("Propositon. For all n in N, 1 + 2 + ... + n = n(n+1)/2.")]);
  assert.equal(nearly.paragraphs.length, 0);
});

test("after scrolling, keeps only the new lines of a mostly-old paragraph", () => {
  const c = new TextCleaner({ engine: "document", mode: "window", minConfidence: 0.35 });
  c.clean([block("Line one of the proof goes here\nLine two of the proof goes here\nLine three of the proof goes here")]);
  const r = c.clean([block("Line two of the proof goes here\nLine three of the proof goes here\nLine four is brand new text")]);
  assert.deepEqual(r.paragraphs, ["Line four is brand new text"]);
});

test("a mostly-new paragraph is kept whole, even with a repeated short line", () => {
  const c = new TextCleaner({ engine: "document", mode: "window", minConfidence: 0.35 });
  c.clean([block("Proof.\nBase case holds trivially for n equals one")]);
  const r = c.clean([block("Proof.\nAssume k divides both a and b here\nThen k divides their sum a plus b")]);
  assert.equal(r.paragraphs[0].split("\n").length, 3);
});

test("groupLines joins nearby lines into one paragraph and splits on gaps", () => {
  const g = groupLines([block("first line", 0.1), block("second line", 0.135), block("far away", 0.5)]);
  assert.deepEqual(g.map((b) => b.text), ["first line\nsecond line", "far away"]);
});

test("menu bar is dropped in display mode", () => {
  const c = new TextCleaner({ engine: "document", mode: "display", minConfidence: 0.35 });
  const r = c.clean([block("Safari File Edit View History", 0.002, 0.1, 0.02), block("Real content line here", 0.4)]);
  assert.deepEqual(r.paragraphs, ["Real content line here"]);
});

test("redaction hides card numbers, SINs, long digit strings and text after 'password'", () => {
  assert.equal(redact("Card 4111 1111 1111 1111 exp").text, "Card [redacted] exp");
  assert.equal(redact("SIN 123-456-789").text, "SIN [redacted]");
  assert.equal(redact("acct 1234567890123").text, "acct [redacted]");
  assert.equal(redact("Password: hunter2").text, "Password [redacted]");
});

test("redaction leaves ordinary math alone", () => {
  for (const s of ["sin x + cos x = 1", "2 3 5 7 11 13 17 19 23", "gcd(1071, 462) = 21", "x^2 + 2x + 1"]) {
    assert.equal(redact(s).text, s);
  }
});
