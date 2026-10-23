// Units (topics under general headings) and cross-references between notes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StudyDb } from "./db.ts";
import { topicKey } from "./notes.ts";
import { MockProvider, provider, setProvider } from "./provider.ts";
import { planUnits, resolveUnits, unitKey } from "./units.ts";
import { buildXrefs, collectTerms, findTerms, meaningful, termTexts, type XrefTopic } from "./xref.ts";
import { applyXrefs, parseXrefHref } from "../shared/xrefLinks.ts";

test("units: the model's names are tidied, matched to existing units, and only asked-about topics are placed", () => {
  const todo = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const out = resolveUnits(
    { assignments: [{ topic: 1, unit: "induction" }, { topic: 2, unit: "Unit 3: sets and subsets" }, { topic: 2, unit: "Logic" }, { topic: 9, unit: "X" }, { topic: 3, unit: "" }] },
    todo,
    [{ title: "Induction" }],
  );
  assert.deepEqual(out, [
    { topicId: "a", unit: "Induction", existing: true },
    { topicId: "b", unit: "Sets and Subsets", existing: false },
  ]);
});

test("units: the prompt shows the course's units and only the unsorted topics", async () => {
  const before = provider();
  const mock = new MockProvider(() => JSON.stringify({ assignments: [{ topic: 1, unit: "Induction" }] }));
  setProvider(mock);
  try {
    const out = await planUnits("MATH 135", [{ title: "Induction", topics: ["Strong Induction"] }], [{ id: "t2", title: "Principle of Induction", summary: "" }], { model: "m" });
    assert.deepEqual(out, [{ topicId: "t2", unit: "Induction", existing: true }]);
    const prompt = mock.calls[0].messages.map((m) => m.content).join("\n");
    assert.match(prompt, /- Induction: "Strong Induction"/);
    assert.match(prompt, /1\. Principle of Induction/);
  } finally {
    setProvider(before);
  }
});

function notesDb() {
  const db = new StudyDb(":memory:");
  const s = db.createSession({ courseId: "math135", startedAt: "2026-10-01T20:00:00.000Z" });
  const chunk = db.addChunk(s, "math135", { text: "x", sourceApp: "Preview", sourceTitle: "x", capturedAt: "2026-10-01T20:01:00.000Z" });
  const topic = (title: string, courseId = "math135") =>
    db.saveTopicNotes({ courseId, title, key: topicKey(title), summary: "", sessionId: s, sections: [{ kind: "point", title: "p", body: "b", passageId: chunk }] });
  return { db, topic };
}

test("units: you can move topics and rename units; the AI never moves a topic you placed", () => {
  const { db, topic } = notesDb();
  const strong = topic("Strong Induction");
  const pomi = topic("Principle of Induction");
  const sets = topic("Set Equality");
  const induction = db.createUnit("math135", "Induction", unitKey("Induction"));
  // The AI sorts two topics.
  db.placeTopic(strong, induction, { byYou: false });
  db.placeTopic(pomi, induction, { byYou: false });
  assert.deepEqual(db.courseNotes("math135").topics.filter((t) => t.unitId === induction).map((t) => t.id), [strong, pomi]);
  // You move "Principle of Induction" before "Strong Induction", and "Set Equality" into a new unit.
  db.placeTopic(pomi, induction, { byYou: true, beforeTopicId: strong });
  assert.deepEqual(db.courseNotes("math135").topics.filter((t) => t.unitId === induction).map((t) => t.id), [pomi, strong]);
  const mine = db.createUnit("math135", "Sets", unitKey("Sets"), true);
  db.placeTopic(sets, mine, { byYou: true });
  // The AI tries to move them: nothing happens.
  db.placeTopic(sets, induction, { byYou: false });
  db.placeTopic(pomi, null, { byYou: false });
  const after = db.courseNotes("math135");
  assert.equal(after.topics.find((t) => t.id === sets)?.unitId, mine);
  assert.equal(after.topics.find((t) => t.id === pomi)?.unitId, induction);
  assert.ok(after.topics.find((t) => t.id === sets)?.locked);
  // Renaming keeps the unit and its topics.
  db.renameUnit(induction, "Proof by Induction", unitKey("Proof by Induction"));
  assert.deepEqual(db.courseNotes("math135").units.map((u) => u.title), ["Proof by Induction", "Sets"]);
  assert.equal(db.getTopic(pomi)?.unit?.title, "Proof by Induction");
  // Removing a unit leaves its topics unsorted, and they stay where you'd want them (locked from the AI).
  db.deleteUnit(mine);
  assert.equal(db.courseNotes("math135").topics.find((t) => t.id === sets)?.unitId, null);
  assert.deepEqual(db.coursesWithUnsortedTopics(), []);
  // A topic can't be moved into another course's unit.
  const cs = db.createUnit("cs135", "Lists", unitKey("Lists"));
  db.placeTopic(strong, cs, { byYou: true });
  assert.equal(db.courseNotes("math135").topics.find((t) => t.id === strong)?.unitId, induction);
  db.close();
});

test("units: a unit the AI made goes away with its last topic; one you named stays", () => {
  const { db, topic } = notesDb();
  const a = topic("Strong Induction");
  const b = topic("Set Equality");
  const ai = db.createUnit("math135", "Induction", unitKey("Induction"));
  const yours = db.createUnit("math135", "Sets", unitKey("Sets"), true);
  db.placeTopic(a, ai, { byYou: false });
  db.placeTopic(b, yours, { byYou: true });
  db.deleteTopic(a);
  db.deleteTopic(b);
  assert.deepEqual(db.courseNotes("math135").units.map((u) => u.title), ["Sets"]);
  db.close();
});

test("cross-references: only named terms count, never common words", () => {
  assert.deepEqual(termTexts("Principle of Strong Induction (POSI)"), ["Principle of Strong Induction", "POSI"]);
  assert.deepEqual(termTexts("Continuity via Limits"), ["Continuity"]);
  assert.deepEqual(termTexts("Proof by Induction"), ["Proof by Induction"]);
  assert.deepEqual(termTexts("Subset Relationship"), ["Subset"]);
  assert.ok(meaningful("Geometric Mean"));
  assert.ok(meaningful("Continuity"));
  assert.ok(meaningful("POSI"));
  for (const word of ["Proof", "Example", "Set", "Notation", "Key Ideas", "Proof Method"]) assert.ok(!meaningful(word), word);
});

test("cross-references: a term that's in most topics is as good as a common word, so it isn't linked", () => {
  const page = (id: string, body: string, kind = "point", title = "p"): XrefTopic => ({ id, courseId: "math137", title: `Topic ${id}`, summary: "", sections: [{ id: `${id}s`, kind, title, body }] });
  const notes = [
    page("a", "The limit of a sequence.", "definition", "Limit"),
    page("b", "Every limit here; also the squeeze theorem."),
    page("c", "A limit again."),
    page("d", "The limit is unique."),
    page("e", "Nothing."),
    page("f", "If both sides converge, use the Squeeze Theorem.", "theorem", "Squeeze Theorem"),
  ];
  const links = buildXrefs(notes);
  assert.deepEqual(links.get("b")?.bs?.map((x) => x.text), ["squeeze theorem"]); // "limit" is on 4 of 6 pages: not linked
});

const topics: XrefTopic[] = [
  {
    id: "amgm",
    courseId: "math135",
    title: "AM-GM Inequality",
    summary: "",
    sections: [
      { id: "am", kind: "definition", title: "Arithmetic Mean", body: "The arithmetic mean of $x$ and $y$ is $(x+y)/2$." },
      { id: "gm", kind: "definition", title: "Geometric Mean", body: "The geometric mean is $\\sqrt{xy}$." },
    ],
  },
  {
    id: "iff",
    courseId: "math135",
    title: "Proving If and Only If",
    summary: "Shows the arithmetic mean is at least the geometric mean.",
    sections: [{ id: "s1", kind: "point", title: "Means", body: "Compare geometric means with `geometric mean` code and $geometric mean$ math. The geometric mean again." }],
  },
  {
    id: "limits",
    courseId: "math137",
    title: "Limits of Sequences",
    summary: "",
    sections: [{ id: "s2", kind: "example", title: "Means", body: "A sequence of arithmetic means; see also the AM-GM inequality." }],
  },
];

test("cross-references: terms in other topics and courses link to where they're explained, once each", () => {
  const terms = collectTerms(topics);
  assert.ok(terms.some((t) => t.text === "Arithmetic Mean" && t.sectionId === "am"));
  // Never to its own topic; plurals count; math and code don't.
  assert.deepEqual(findTerms("The arithmetic mean here.", terms, "amgm"), []);
  assert.deepEqual(
    findTerms(topics[1].sections[0].body, terms, "iff").map((x) => x.text),
    ["geometric means"],
  );
  const all = buildXrefs(topics);
  assert.deepEqual(all.get("iff")?.summary?.map((x) => [x.text, x.sectionId]), [["arithmetic mean", "am"], ["geometric mean", "gm"]]);
  // Another course links too (to a section, and to a whole topic by its title).
  assert.deepEqual(all.get("limits")?.s2?.map((x) => [x.text, x.topicId, x.sectionId]), [["arithmetic means", "amgm", "am"], ["AM-GM inequality", "amgm", undefined]]);
});

test("cross-references: links go into the formatted notes outside math, code and other links", () => {
  const md = "The $geometric mean$ and `geometric mean`, then the Geometric Mean and the geometric mean.";
  const out = applyXrefs(md, [{ text: "Geometric Mean", topicId: "amgm", sectionId: "gm", label: 'AM-GM › "Geometric" Mean' }]);
  assert.equal(out, "The $geometric mean$ and `geometric mean`, then the [Geometric Mean](#xref/amgm/gm \"AM-GM › 'Geometric' Mean\") and the geometric mean.");
  assert.deepEqual(parseXrefHref("#xref/amgm/gm"), { topicId: "amgm", sectionId: "gm" });
  assert.deepEqual(parseXrefHref("#xref/amgm"), { topicId: "amgm", sectionId: undefined });
  assert.equal(parseXrefHref("https://example.com"), null);
  assert.equal(applyXrefs("no match here", [{ text: "Geometric Mean", topicId: "a", label: "x" }]), "no match here");
});

test("cross-references: the cache is used until the notes change", () => {
  const { db, topic } = notesDb();
  topic("Strong Induction");
  const v1 = db.notesVersion();
  assert.equal(db.cachedXrefs(v1), null);
  const built = buildXrefs(db.allNotes());
  db.saveXrefs(v1, built);
  assert.equal(db.cachedXrefs(v1)?.size, 1);
  topic("Set Equality");
  const v2 = db.notesVersion();
  assert.notEqual(v1, v2);
  assert.equal(db.cachedXrefs(v2), null, "new notes: worked out again");
  db.close();
});
