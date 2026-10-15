import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StudyDb } from "./db.ts";
import { grounding, repairLatex, resolvePlan, sameTitle, titleCase, topicKey, validateSections } from "./notes.ts";

const P = (id: string, text: string) => ({ id, text, sourceTitle: "Lecture" });
const courses = [
  { id: "math135", name: "MATH 135" },
  { id: "cs135", name: "CS 135" },
];

test("topic plans: passage numbers become ids, existing names are reused, duplicates merge", () => {
  const used = [P("a", "x"), P("b", "y"), P("c", "z")];
  const plans = resolvePlan(
    {
      topics: [
        { title: "strong induction", course: "MATH 135", passages: [1, 2] },
        { title: "Strong Induction.", course: "math135", passages: [2, 3] },
        { title: "Lists", course: "CS 135", passages: [3] },
        { title: "Nowhere", course: "MATH 135", passages: [9] }, // no real passages: dropped
        { title: "Mystery course", course: "PHYS 999", passages: [1] }, // unknown course: the session's
      ],
    },
    used,
    courses,
    "math135",
    [{ courseId: "math135", title: "Strong Induction" }],
  );
  assert.deepEqual(
    plans.map((p) => [p.courseId, p.title, p.passageIds.join(","), p.existing]),
    [
      ["math135", "Strong Induction", "a,b,c", true],
      ["cs135", "Lists", "c", false],
      ["math135", "Mystery Course", "a", false],
    ],
  );
});

test("titles are title-cased and matched loosely", () => {
  assert.equal(titleCase("limits of a sequence"), "Limits of a Sequence");
  assert.equal(topicKey("Strong inductions!"), topicKey("strong induction"));
});

test("note sections must cite a real passage, match its wording, and not repeat existing notes", () => {
  const used = [P("a", "Strong induction: if P(1) holds and P(1), ..., P(k) together imply P(k+1), then P(n) holds for every natural number n.")];
  const out = validateSections(
    [
      { kind: "theorem", title: "Strong induction", body: "If P(1) holds and P(1), …, P(k) imply P(k+1) for every k, then P(n) holds for every natural number n.", source: 1 },
      { kind: "definition", title: "Group homomorphism", body: "A map between groups that preserves the group operation and sends identity elements together.", source: 1 }, // not in the passage
      { kind: "formula", title: "Bound", body: "$f_n < 2^n$", source: 1 }, // math only: kept
      { kind: "point", title: "Base case", body: "Check P(1) directly.", source: 7 }, // no such passage
      { kind: "weird", title: "Recap", body: "Strong induction assumes every earlier case holds for natural number n.", source: 1 }, // unknown kind -> point
      { kind: "point", title: "Already noted", body: "Strong induction holds for every natural number.", source: 1 },
    ],
    used,
    ["Already Noted"],
  );
  assert.deepEqual(out.map((s) => [s.kind, s.title]), [
    ["theorem", "Strong induction"],
    ["formula", "Bound"],
    ["point", "Recap"],
  ]);
  assert.ok(grounding("A map between groups preserving operations", used[0].text) < 0.3);
});

test("notes: a topic is created once and later material merges into it; search and deletes keep up", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  try {
    const db = new StudyDb(join(dir, "t.db"));
    const s1 = db.createSession({ courseId: "math135", startedAt: "2026-10-01T20:00:00.000Z" });
    const s2 = db.createSession({ courseId: "math135", startedAt: "2026-10-02T20:00:00.000Z" });
    const c1 = db.addChunk(s1, "math135", { text: "Strong induction text", sourceApp: "Chrome", sourceTitle: "Lecture 11", capturedAt: "2026-10-01T20:05:00.000Z" });
    const c2 = db.addChunk(s2, "math135", { text: "More induction", sourceApp: "Chrome", sourceTitle: "Lecture 12", capturedAt: "2026-10-02T20:05:00.000Z" });
    for (const id of [s1, s2]) db.endSession(id, { endedAt: "2026-10-02T21:00:00.000Z", activeMs: 1, stats: {} });
    assert.deepEqual(db.sessionsNeedingNotes().map((s) => s.id), [s1, s2], "oldest first");

    const key = topicKey("Strong Induction");
    const t1 = db.saveTopicNotes({ courseId: "math135", title: "Strong Induction", key, summary: "First.", sessionId: s1, sections: [{ kind: "theorem", title: "POSI", body: "Assume all earlier cases.", passageId: c1 }] });
    db.setNotesStatus(s1, "done");
    assert.deepEqual(db.topicForMerge("math135", key)?.sectionTitles, ["POSI"]);
    const t2 = db.saveTopicNotes({ courseId: "math135", title: "Strong Induction", key, summary: "Updated.", sessionId: s2, sections: [{ kind: "example", title: "Fibonacci bound", body: "Show $f_n < 2^n$.", passageId: c2 }] });
    assert.equal(t2, t1, "merged into the same topic");
    assert.deepEqual(db.sessionsNeedingNotes().map((s) => s.id), [s2]);

    const topic = db.getTopic(t1)!;
    assert.equal(topic.summary, "Updated.");
    assert.deepEqual(topic.sections.map((s) => [s.title, s.capturedAt]), [["POSI", "2026-10-01T20:05:00.000Z"], ["Fibonacci bound", "2026-10-02T20:05:00.000Z"]]);
    const tree = db.noteTree();
    assert.deepEqual(tree.topics.map((t) => [t.title, t.sections]), [["Strong Induction", 2]]);
    assert.equal(tree.pending, 1);

    const [hit] = db.searchNotes("fibonacci");
    assert.equal(hit.kind, "note");
    assert.equal(hit.topicId, t1);
    assert.match(hit.sourceTitle, /\u0001Fibonacci\u0002 bound/);
    assert.equal(db.search("induction").every((m) => m.kind === "capture"), true);

    const extra = db.saveTopicNotes({ courseId: "math135", title: "Course Outline", key: topicKey("Course Outline"), summary: "", sessionId: s2, sections: [{ kind: "point", title: "Weeks", body: "Week 1.", passageId: c2 }] });
    db.deleteTopic(extra);
    assert.equal(db.getTopic(extra), null);
    assert.equal(db.getChunk(c2)?.text, "More induction", "deleting a topic keeps the capture");

    db.deleteChunk(c2);
    assert.equal(db.getTopic(t1)!.sections.length, 1, "a deleted passage takes its note section with it");
    assert.equal(db.searchNotes("fibonacci").length, 0);
    db.deleteSession(s1);
    assert.equal(db.getTopic(t1), null, "a topic with nothing left is removed");
    db.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("LaTeX mangled by JSON parsing is repaired", () => {
  assert.equal(repairLatex("\begin{matrix}"), "\\begin{matrix}"); // "\b" (backspace) + "egin"
  assert.equal(repairLatex("\text{lim}"), "\\text{lim}"); // "\t" (tab) + "ext"
  assert.equal(repairLatex("$\\\\frac{1}{2}$"), "$\\frac{1}{2}$"); // doubled backslash
  assert.equal(repairLatex("a \\\\ b"), "a \\\\ b", "a LaTeX line break stays");
});

test("section titles that say the same thing are recognised", () => {
  assert.ok(sameTitle("Definition of Set Equality", "Set Equality Definition"));
  assert.ok(sameTitle("Product Notation", "Product notation"));
  assert.ok(!sameTitle("Set Equality", "Set Operations"));
  assert.ok(!sameTitle("Arithmetic Mean", "Geometric Mean"));
});
