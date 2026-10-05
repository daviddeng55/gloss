import assert from "node:assert/strict";
import { test } from "node:test";
import { matchConcept, searchPassages, type MemoryPassage } from "./memory.ts";

const p = (id: string, text: string): MemoryPassage => ({ id, text, sourceTitle: id, sessionId: "s", startedAt: "2026-10-01" });

test("search finds passages sharing the question's specific words", () => {
  const ps = [
    p("induction", "Proof by strong induction: assume P(1) through P(k) and prove P(k+1). The base cases must cover x1 and x2."),
    p("sets", "A set S is a subset of T when every element of S is in T. To prove S = T show both inclusions."),
    p("misc", "The course has weekly assignments and a midterm. Read the syllabus for the course policies."),
  ];
  const r = searchPassages("why do I need two base cases in strong induction?", ps);
  assert.equal(r[0].id, "induction");
  assert.ok(!r.some((x) => x.id === "misc"));
});

test("search uses meaning when embeddings exist", () => {
  const ps = [{ ...p("a", "alpha"), embedding: new Float32Array([1, 0]) }, { ...p("b", "beta"), embedding: new Float32Array([0, 1]) }];
  assert.equal(searchPassages("anything", ps, { queryEmbedding: [0.1, 0.9] })[0].id, "b");
});

test("questions are matched to known concepts by name", () => {
  const concepts = [{ id: "c1", name: "strong induction" }, { id: "c2", name: "subsets and set equality" }, { id: "c3", name: "limit of a recursive sequence" }];
  assert.equal(matchConcept("I don't get the inductive step in strong induction", concepts), "c1");
  assert.equal(matchConcept("how do I find the limit of this recursive sequence?", concepts), "c3");
  assert.equal(matchConcept("what's for lunch", concepts), null);
});
