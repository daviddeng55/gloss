import assert from "node:assert/strict";
import { test } from "node:test";
import { TextCleaner, groupLines, isNoiseLine, lineKey, similarKeys } from "./clean.ts";
import type { TextBlock, WindowInfo } from "./helper.ts";
import { blockedReason, isOwnWindow, loadNeverRecord, pickFrontWindow } from "./privacy.ts";
import { redact } from "./redact.ts";

const block = (text: string, y = 0.3, x = 0.1, h = 0.03, confidence = 0.9): TextBlock => ({
  text,
  confidence,
  box: { x, y, w: 0.5, h },
});

test("drops UI noise but keeps short math", () => {
  for (const s of ["File", "Edit", "Share", "12:45 PM", "87%", "•", "learn.uwaterloo.ca/d2l/home", "Sign in",
    "inG", "D2L", "10 c*", "| º9", "PM", "Ask Gemini", "- Automatic Zoom v", "All Bookmarks", "of 21", "6 / 36 - 1009 ç", "_ - 100% + O", "6 / 36 = 100% ÷ ∞ æ", "22[ +1 = 2[2[[[3]\" = 10 •51 [ =] [5[2 []0e2"]) {
    assert.ok(isNoiseLine(s), s);
  }
  for (const s of ["x = 1", "Proof.", "a | b", "n(n+1)/2", "Lecture 7: Induction", "1/2 + 1/4 = 3/4", "Grade: 85% of marks"]) {
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

test("the same math line read twice with OCR jitter counts as a repeat", () => {
  const pairs = [
    ["2(-3)2 + 10 • 51 = 18 + 50 = 68 = x2.", "2(-3)2 + 10-5' = 18 + 50 = 68 = x2."],
    ["2(-3)'+10.5º=-6+ 10= 4 = x1", "2(-3)+10•5°=-6+10=4= x1"],
    ["In grouns: Why does this proof fail?", "In groups: Why does this proof fail?"],
  ];
  for (const [a, b] of pairs) assert.ok(similarKeys(lineKey(a), lineKey(b)), `${a} ~ ${b}`);
});

test("different lines that look alike are not merged", () => {
  const pairs = [
    ["Case: k + 1 is even. If k + 1 is even, then 1 ≤ k+1 ≤ k so by", "Case: k + 1 is odd. If k + 1 is odd, then k is even and we may"],
    ["2(-3)^1 + 10·5^0 = -6 + 10 = 4 = x1", "2(-3)^2 + 10·5^1 = 18 + 50 = 68 = x2"],
  ];
  for (const [a, b] of pairs) assert.ok(!similarKeys(lineKey(a), lineKey(b)), `${a} !~ ${b}`);
});

test("browser tabs and toolbar at the top of a window are dropped", () => {
  const c = new TextCleaner({ engine: "document", mode: "window", minConfidence: 0.35 });
  // Real Chrome window, 801 pt tall: tabs at 2%, address bar at 7%, bookmarks bar at 11–12%.
  const r = c.clean(
    [block("Math 137 cs 135 Comm101", 0.016, 0.1, 0.013), block("student.cs.uwaterloo.ca/~cs135", 0.061, 0.1, 0.019),
      block("commst100 clubs Math 135", 0.107, 0.1, 0.013), block("Lecture 11 - Strong Induction", 0.3)],
    { bundleId: "com.google.Chrome", height: 801 },
  );
  assert.deepEqual(r.paragraphs, ["Lecture 11 - Strong Induction"]);
});

const win = (o: Partial<WindowInfo>): WindowInfo => ({
  windowId: 1, app: "Google Chrome", bundleId: "com.google.Chrome", pid: 10, title: "", width: 1470, height: 800, ...o,
});

test("full-screen Chrome: picks the page window, not the untitled toolbar strips", () => {
  const w = pickFrontWindow([
    win({ windowId: 1, height: 41 }),
    win({ windowId: 2, height: 158 }),
    win({ windowId: 3, title: "CS135-F26-L06" }),
    win({ windowId: 9, app: "Code", bundleId: "com.microsoft.VSCode", pid: 20, title: "x — nook" }),
  ]);
  assert.equal(w?.windowId, 3);
});

test("this project's own editor/terminal windows are skipped, other VS Code folders are not", () => {
  const code = (title: string) => win({ app: "Code", bundleId: "com.microsoft.VSCode", title });
  assert.ok(isOwnWindow(code("package-lock.json — nook"), "nook"));
  assert.ok(isOwnWindow(code("nook"), "nook"));
  assert.ok(isOwnWindow(win({ app: "Terminal", bundleId: "com.apple.Terminal", title: "nook — node src/session.ts — 80×24" }), "nook"));
  assert.ok(!isOwnWindow(code("a03.rkt — cs135"), "nook"));
  assert.ok(!isOwnWindow(win({ title: "The Nook e-reader — Google Chrome" }), "nook"));
});

test("never-record list blocks Gmail, LinkedIn and the Claude app", () => {
  const list = loadNeverRecord(new URL("../never-record.json", import.meta.url).pathname);
  assert.ok(blockedReason(win({ title: "Inbox (4,566) - student@example.com - Gmail" }), list, "nook"));
  assert.ok(blockedReason(win({ title: "(21) Messaging | LinkedIn" }), list, "nook"));
  assert.ok(blockedReason(win({ app: "Claude", bundleId: "com.anthropic.claudefordesktop", title: "Claude" }), list, "nook"));
  assert.equal(blockedReason(win({ title: "Lecture 11 - Strong Induction - MATH 135 - LEARN" }), list, "nook"), null);
});
