import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfusionDetector } from "./confusion.ts";

const MIN = 60_000;

test("coming back to the same page three times offers help, once", () => {
  const d = new ConfusionDetector();
  const pages = ["notes", "other", "notes", "other", "notes", "other", "notes", "other", "notes"];
  const hints = pages.map((page, i) => d.observe({ at: i * MIN, page, title: page === "notes" ? "Lecture 11" : "Piazza", changed: true }));
  const offered = hints.filter(Boolean);
  assert.equal(offered.length, 1);
  assert.match(offered[0]!, /Lecture 11/);
});

test("an unchanged screen for 6+ minutes offers help; normal reading doesn't", () => {
  const d = new ConfusionDetector();
  let hint: string | null = null;
  for (let t = 0; t <= 7 * MIN; t += MIN / 12) hint ??= d.observe({ at: t, page: "p", title: "A03.pdf", changed: t === 0 });
  assert.match(hint ?? "", /same part of "A03.pdf"/);
  const reading = new ConfusionDetector();
  let none: string | null = null;
  for (let t = 0; t <= 20 * MIN; t += MIN) none ??= reading.observe({ at: t, page: "p", title: "notes", changed: true });
  assert.equal(none, null);
});

test("offers are spaced out (15 minutes)", () => {
  const d = new ConfusionDetector();
  let count = 0;
  for (let t = 0; t <= 14 * MIN; t += MIN / 12) if (d.observe({ at: t, page: `p${Math.floor(t / (7 * MIN))}`, title: "x", changed: false })) count++;
  assert.equal(count, 1);
});
