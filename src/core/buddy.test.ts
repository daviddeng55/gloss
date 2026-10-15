import assert from "node:assert/strict";
import { test } from "node:test";
import { BuddyTrigger, buddyQuestion, buddyReact, dominantConcept, focusFor, MAX_FOLLOW_UPS, nextStep, type Focus, type TriggerContext } from "./buddy.ts";
import { conceptState } from "./learner.ts";
import { MockProvider, provider, setProvider } from "./provider.ts";

const MIN = 60_000;
const page = (name: string): Focus => ({ key: `page:${name}`, label: name, page: name });
const ok: TriggerContext = { enabled: true, paused: false, asking: false, lastAskAt: -Infinity, idleMs: 60_000 };

/** Screen checks every 5 s on one focus, from `from` for `ms`. Returns the time after the last check. */
function stay(t: BuddyTrigger, focus: Focus, from: number, ms: number): number {
  let at = from;
  for (; at <= from + ms; at += 5000) t.observe(at, focus);
  return at;
}

test("never appears while you're still on the same thing, however long", () => {
  const t = new BuddyTrigger();
  const end = stay(t, page("A"), 0, 30 * MIN);
  assert.equal(t.decide(end, ok), null);
});

test("appears after you finish something and move on (once you've settled on the next thing)", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, 5 * MIN);
  t.observe(at, page("B"));
  assert.deepEqual(t.decide(at + 2000, ok), { wait: "just moved on" }); // might just be a glance
  at = stay(t, page("B"), at + 5000, 10_000);
  const d = t.decide(at, ok);
  assert.ok(d && "show" in d);
  assert.equal(d.show.focus.key, "page:A");
  assert.ok(d.show.dwellMs >= 5 * MIN);
});

test("a short look at something isn't 'finishing' it", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, 2 * MIN);
  at = stay(t, page("B"), at, 20_000);
  assert.equal(t.decide(at, ok), null);
});

test("glancing away and coming back means you weren't done", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, 5 * MIN);
  t.observe(at, page("B"));
  at = stay(t, page("A"), at + 5000, 10_000); // back to A
  assert.equal(t.decide(at, ok), null);
  // Time on A keeps adding up, and moving on later still counts.
  at = stay(t, page("A"), at, MIN);
  at = stay(t, page("C"), at, 15_000);
  const d = t.decide(at, ok);
  assert.ok(d && "show" in d && d.show.focus.key === "page:A");
});

test("too late once you're reading the next thing", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, 5 * MIN);
  at = stay(t, page("B"), at, 2 * MIN); // a grace period of 75 s has passed
  assert.deepEqual(t.decide(at, ok), { skip: "you're reading the next thing now" });
  assert.equal(t.decide(at + 5000, ok), null); // and the moment is gone
});

test("waits while you're typing, then appears", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, 5 * MIN);
  at = stay(t, page("B"), at, 15_000);
  assert.deepEqual(t.decide(at, { ...ok, idleMs: 0 }), { wait: "typing" });
  assert.ok("show" in (t.decide(at + 5000, { ...ok, idleMs: 4000 }) ?? {}));
});

test("stays away during circle-and-ask and for 2 minutes after", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, 5 * MIN);
  at = stay(t, page("B"), at, 15_000);
  assert.deepEqual(t.decide(at, { ...ok, asking: true }), { wait: "circle and ask" });
  assert.deepEqual(t.decide(at, { ...ok, lastAskAt: at - 30_000 }), { wait: "circle and ask" });
  assert.ok("show" in (t.decide(at, { ...ok, lastAskAt: at - 3 * MIN }) ?? {}));
});

test("waits while the session is paused", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, 5 * MIN);
  at = stay(t, page("B"), at, 15_000);
  assert.deepEqual(t.decide(at, { ...ok, paused: true }), { wait: "session paused" });
});

test("at most once every 15 minutes (adjustable)", () => {
  const t = new BuddyTrigger({ cooldownMs: 15 * MIN });
  let at = stay(t, page("A"), 0, 5 * MIN);
  at = stay(t, page("B"), at, 15_000);
  const first = t.decide(at, ok);
  assert.ok(first && "show" in first);
  t.shown(at, first.show);
  // B finished 6 minutes later: too soon.
  at = stay(t, page("B"), at, 6 * MIN);
  at = stay(t, page("C"), at, 15_000);
  assert.deepEqual(t.decide(at, ok), { skip: "appeared recently" });
  // C finished after the 15 minutes are up: fine.
  at = stay(t, page("C"), at, 10 * MIN);
  at = stay(t, page("D"), at, 15_000);
  const later = t.decide(at, ok);
  assert.ok(later && "show" in later && later.show.focus.key === "page:C");

  const t20 = new BuddyTrigger({ cooldownMs: 20 * MIN });
  let at2 = stay(t20, page("A"), 0, 5 * MIN);
  at2 = stay(t20, page("B"), at2, 15_000);
  t20.shown(at2, (t20.decide(at2, ok) as { show: any }).show);
  at2 = stay(t20, page("B"), at2, 16 * MIN);
  at2 = stay(t20, page("C"), at2, 15_000);
  assert.deepEqual(t20.decide(at2, ok), { skip: "appeared recently" });
});

test("never asks about the same thing twice in a session", () => {
  const t = new BuddyTrigger({ cooldownMs: 0 });
  let at = stay(t, page("A"), 0, 5 * MIN);
  at = stay(t, page("B"), at, 15_000);
  t.shown(at, (t.decide(at, ok) as { show: any }).show);
  at = stay(t, page("A"), at, 5 * MIN);
  at = stay(t, page("C"), at, 15_000);
  assert.equal(t.decide(at, ok), null);
});

test("'Not now' snoozes for 20 minutes; 'Pause for this session' and the off switch stop it", () => {
  const t = new BuddyTrigger({ cooldownMs: 0 });
  let at = stay(t, page("A"), 0, 5 * MIN);
  at = stay(t, page("B"), at, 15_000);
  t.snooze(at);
  at = stay(t, page("B"), at, 5 * MIN);
  at = stay(t, page("C"), at, 15_000);
  assert.deepEqual(t.decide(at, ok), { skip: "snoozed" });
  at = stay(t, page("C"), at + 20 * MIN, 5 * MIN);
  at = stay(t, page("D"), at, 15_000);
  assert.ok("show" in (t.decide(at, ok) ?? {}));
  assert.deepEqual(t.decide(at, { ...ok, enabled: false }), { skip: "turned off" });

  const p = new BuddyTrigger();
  let at2 = stay(p, page("A"), 0, 5 * MIN);
  p.pauseForSession();
  at2 = stay(p, page("B"), at2, 15_000);
  assert.deepEqual(p.decide(at2, ok), { skip: "paused for this session" });
});

test("pauses and sleep don't count as time spent", () => {
  const t = new BuddyTrigger();
  let at = stay(t, page("A"), 0, MIN);
  t.observe(at + 60 * MIN, page("A")); // an hour later (Mac was asleep)
  assert.ok(t.dwellOn("page:A") < 2 * MIN);
  at = stay(t, page("B"), at + 60 * MIN + 5000, 15_000);
  assert.equal(t.decide(at, ok), null);
});

test("skips concepts you clearly know already", () => {
  const t = new BuddyTrigger();
  const focus: Focus = { key: "concept:c1", label: "strong induction", page: "A", conceptId: "c1" };
  let at = stay(t, focus, 0, 5 * MIN);
  at = stay(t, page("B"), at, 15_000);
  assert.deepEqual(t.decide(at, { ...ok, mastery: () => ({ current: 0.9, confidence: 0.8 }) }), { skip: "you know this one well" });
});

test("concept changes inside one page count as moving on", () => {
  const concepts = [
    { id: "c1", name: "Strong induction" },
    { id: "c2", name: "Well-ordering principle" },
  ];
  const a = focusFor("pdf", "Lecture 7.pdf", "Strong induction: assume P(1..k). By strong induction we get P(k+1).", concepts);
  const b = focusFor("pdf", "Lecture 7.pdf", "The well-ordering principle says ... by the well ordering principle, every set", concepts);
  assert.equal(a.key, "concept:c1");
  assert.equal(b.key, "concept:c2");
  const t = new BuddyTrigger();
  let at = stay(t, a, 0, 5 * MIN);
  at = stay(t, b, at, 15_000);
  const d = t.decide(at, ok);
  assert.ok(d && "show" in d && d.show.focus.conceptId === "c1");
});

test("the main concept on screen needs to clearly lead", () => {
  const concepts = [
    { id: "c1", name: "Strong induction" },
    { id: "c2", name: "Sets" },
    { id: "c3", name: "GCD" }, // too short to count
  ];
  assert.equal(dominantConcept("strong induction once", concepts), null);
  assert.equal(dominantConcept("sets and sets, strong induction and strong induction", concepts), null); // a tie
  assert.equal(dominantConcept("GCD GCD GCD", concepts), null);
  assert.equal(dominantConcept("Strong Induction... strong induction! sets", concepts)?.id, "c1");
  assert.equal(focusFor("chrome|x", "Lecture 7 — Sets - Google Chrome", "", concepts).label, "Lecture 7 — Sets");
});

test("a shaky answer gets at most two gentle follow-ups, then thanks", () => {
  assert.deepEqual(nextStep("solid", 0, ""), { mood: "happy", done: true });
  assert.deepEqual(nextStep("gap", 0, "But what if k = 0?"), { mood: "confused", ask: "But what if k = 0?", done: false });
  assert.deepEqual(nextStep("gap", 1, "Hmm, and then?"), { mood: "confused", ask: "Hmm, and then?", done: false });
  assert.deepEqual(nextStep("gap", MAX_FOLLOW_UPS, "One more?"), { mood: "thanks", done: true });
  assert.deepEqual(nextStep("gap", 0, "  "), { mood: "thanks", done: true });
});

test("the buddy's question and reaction come from the model (mocked), cleaned up", async () => {
  const before = provider();
  const replies = [
    '{"question":"\\"Wait, why can you assume all smaller cases in strong induction\\"","concept":"Strong induction"}',
    '{"verdict":"gap","followUp":"Hmm, but what do you need to check first?"}',
    '{"verdict":"solid","followUp":"ignored"}',
    '{"verdict":"maybe?","followUp":""}',
  ];
  const mock = new MockProvider(() => replies.shift() ?? "{}");
  setProvider(mock);
  try {
    const q = await buddyQuestion({ character: "cat", name: "Miso", course: "MATH 135", focusLabel: "strong induction", text: "…", knownConcepts: ["Strong induction"] });
    assert.deepEqual(q, { question: "Wait, why can you assume all smaller cases in strong induction?", concept: "Strong induction" });
    assert.match(mock.calls[0].messages[0].content, /curious classmate/);
    assert.match(mock.calls[0].messages[0].content, /Never grade/);
    const turns = [
      { who: "buddy" as const, text: q.question, at: "" },
      { who: "you" as const, text: "because you proved them", at: "" },
    ];
    assert.deepEqual(await buddyReact({ character: "cat", name: "Miso", course: "MATH 135", text: "…", turns }), { verdict: "gap", followUp: "Hmm, but what do you need to check first?" });
    assert.deepEqual(await buddyReact({ character: "cat", name: "Miso", course: "MATH 135", text: "…", turns }), { verdict: "solid", followUp: "" });
    assert.equal((await buddyReact({ character: "cat", name: "Miso", course: "MATH 135", text: "…", turns })).verdict, "gap"); // unclear = gap
    await assert.rejects(buddyQuestion({ character: "cat", name: "Miso", course: "M", focusLabel: "x", text: "", knownConcepts: [] })); // empty
  } finally {
    setProvider(before);
  }
});

test("explaining to the buddy moves mastery (less than a quiz answer)", () => {
  const at = "2026-10-15T12:00:00.000Z";
  const now = Date.parse(at);
  const covered = { at: "2026-10-15T11:00:00.000Z", kind: "covered" as const };
  const solid = conceptState([covered, { at, kind: "explain", correct: true }], now);
  const gap = conceptState([covered, { at, kind: "explain", correct: false }], now);
  const quiz = conceptState([covered, { at, kind: "quiz", correct: true }], now);
  assert.ok(solid.current > 0.25 && solid.current < quiz.current);
  assert.ok(gap.current < 0.25);
  assert.deepEqual(solid.explained, { solid: 1, gaps: 0 });
  assert.ok(solid.why.some((w) => w.includes("Study Buddy")));
});
