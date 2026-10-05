import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Chunker, type NewChunk } from "./chunker.ts";
import { StudyDb } from "./db.ts";

const entry = (text: string, title = "Lecture 11", at = "2026-10-02T20:00:00.000Z") => ({
  capturedAt: at, app: "Google Chrome", title, text,
});

test("chunker groups small captures from one window and cuts on window change", () => {
  const out: NewChunk[] = [];
  const c = new Chunker((ch) => out.push(ch), { targetChars: 100, maxChars: 200, maxAgeMs: 60_000 });
  c.add(entry("Base case: P(1) holds."));
  c.add(entry("Inductive step: assume P(k)."));
  assert.equal(out.length, 0); // still short, waiting for more
  c.add(entry("Gmail stuff", "Other window"));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Base case: P(1) holds.\n\nInductive step: assume P(k).");
  assert.equal(out[0].sourceTitle, "Lecture 11");
  c.flush();
  assert.equal(out.length, 2);
});

test("chunker cuts at the target size and splits very long paragraphs", () => {
  const out: NewChunk[] = [];
  const c = new Chunker((ch) => out.push(ch), { targetChars: 100, maxChars: 150, maxAgeMs: 60_000 });
  c.add(entry(Array.from({ length: 10 }, (_, i) => `Line ${i} of a long proof goes here`).join("\n")));
  c.flush();
  assert.ok(out.length >= 3);
  assert.ok(out.every((ch) => ch.text.length <= 150), "no chunk over max");
  assert.equal(out.map((ch) => ch.text).join("\n").split("\n").length, 10, "no lines lost");
});

test("chunker flushes text that has waited too long", () => {
  const out: NewChunk[] = [];
  const c = new Chunker((ch) => out.push(ch), { targetChars: 1000, maxChars: 2000, maxAgeMs: 60_000 });
  c.add(entry("short", "T", "2026-10-02T20:00:00.000Z"));
  c.flushIfStale(Date.parse("2026-10-02T20:00:30.000Z"));
  assert.equal(out.length, 0);
  c.flushIfStale(Date.parse("2026-10-02T20:01:01.000Z"));
  assert.equal(out.length, 1);
});

test("database saves sessions and chunks and lists them newest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  try {
    const path = join(dir, "t.db");
    let db = new StudyDb(path);
    const a = db.createSession({ courseId: "math135", goal: "induction", startedAt: "2026-10-01T20:00:00.000Z" });
    db.addChunk(a, "math135", { text: "Proof by induction", sourceApp: "Chrome", sourceTitle: "L11", capturedAt: "2026-10-01T20:01:00.000Z" });
    db.endSession(a, { endedAt: "2026-10-01T20:30:00.000Z", activeMs: 25 * 60_000, stats: { ticks: 3 } });
    const b = db.createSession({ courseId: "cs135", startedAt: "2026-10-02T20:00:00.000Z" });
    db.addChunk(b, "cs135", { text: "(define (f n) ...)", sourceApp: "DrRacket", sourceTitle: "a03.rkt", capturedAt: "2026-10-02T20:05:00.000Z" });
    db.close();

    // Reopening closes the unfinished session at its last text.
    db = new StudyDb(path);
    const list = db.listSessions();
    assert.deepEqual(list.map((s) => s.courseId), ["cs135", "math135"]);
    assert.equal(list[0].endedAt, "2026-10-02T20:05:00.000Z");
    assert.equal(list[1].activeMs, 25 * 60_000);
    assert.equal(list[1].goal, "induction");
    assert.equal(list[1].chunkCount, 1);
    const detail = db.getSession(a)!;
    assert.equal(detail.chunks[0].text, "Proof by induction");
    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("deleting a session removes its notes, quiz, questions and learner evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  try {
    const db = new StudyDb(join(dir, "t.db"));
    const keep = db.createSession({ courseId: "math135", startedAt: "2026-10-01T20:00:00.000Z" });
    const gone = db.createSession({ courseId: "math135", startedAt: "2026-10-02T20:00:00.000Z" });
    const c1 = db.addChunk(keep, "math135", { text: "induction", sourceApp: "x", sourceTitle: "x", capturedAt: "2026-10-01T20:01:00.000Z" });
    const c2 = db.addChunk(gone, "math135", { text: "sets", sourceApp: "x", sourceTitle: "x", capturedAt: "2026-10-02T20:01:00.000Z" });
    const shared = db.upsertConcept("math135", "strong induction");
    const only = db.upsertConcept("math135", "set equality");
    db.linkConcept(shared, c1, keep);
    db.linkConcept(shared, c2, gone);
    db.linkConcept(only, c2, gone);
    db.addEvidence(shared, { at: "2026-10-02T20:05:00.000Z", kind: "quiz", correct: false, sessionId: gone });
    db.addEvidence(only, { at: "2026-10-02T20:05:00.000Z", kind: "covered", sessionId: gone });
    db.saveQuiz(gone, "math135", [{ type: "short_answer", question: "Q", answer: "A", passageId: c2 }]);
    db.addQuestion(gone, "math135", "what?", "x");
    db.deleteSession(gone);
    assert.deepEqual(db.listSessions().map((s) => s.id), [keep]);
    const concepts = db.getConcepts("math135");
    assert.deepEqual(concepts.map((c) => c.name), ["strong induction"], "concept only from the deleted session is gone");
    assert.equal(concepts[0].evidence.length, 0, "evidence from the deleted session is gone");
    db.deleteCourseData("math135");
    assert.equal(db.listSessions().length, 0);
    assert.equal(db.getConcepts().length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("settings are kept in sensible ranges", async () => {
  const { sanitizeSettings, DEFAULT_SETTINGS_FILE } = await import("./settings.ts");
  const s = sanitizeSettings({
    ...DEFAULT_SETTINGS_FILE,
    capture: { intervalSeconds: 0, dwellSeconds: 999 },
    ask: { ...DEFAULT_SETTINGS_FILE.ask, fallbackW: Number.NaN, shortcut: "" },
  });
  assert.deepEqual(s.capture, { intervalSeconds: 2, dwellSeconds: 60 });
  assert.equal(s.ask.fallbackW, 900);
  assert.equal(s.ask.shortcut, "Alt+A");
});
