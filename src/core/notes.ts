// Class notes: after a session, its captured passages are sorted into topics (per course) and written
// up as clean notes — summary, definitions, theorems/formulas, worked examples, common mistakes.
// A topic that already exists gets only the new material (merged, not duplicated).
import { chat, DEFAULT_AI, ensureMathDelimiters, numbered, TUTOR_RULES, type AiConfig, type Passage } from "./ai.ts";
import { conceptKey } from "./learner.ts";

export type NoteKind = "definition" | "theorem" | "formula" | "example" | "mistake" | "point";
export const NOTE_KINDS: NoteKind[] = ["definition", "theorem", "formula", "example", "mistake", "point"];

/** One topic found in a session: which course it belongs to and which passages cover it. */
export type TopicPlan = { title: string; courseId: string; passageIds: string[]; existing: boolean };
export type NoteSectionDraft = { kind: NoteKind; title: string; body: string; passageId: string };
export type TopicNotes = { summary: string; sections: NoteSectionDraft[] };

/** Topic names are matched by this key, so "Strong induction" and "strong Induction." are one topic. */
export const topicKey = conceptKey;

/** "strong induction" -> "Strong Induction" (small words stay lower-case). */
export function titleCase(s: string): string {
  const small = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);
  return s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ---------- 1. topics ----------

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          course: { type: "string" },
          passages: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "course", "passages"],
      },
    },
  },
  required: ["topics"],
};

type RawPlan = { topics?: { title?: string; course?: string; passages?: number[] }[] };

/**
 * Turns the model's topic list into plans: passage numbers become ids, courses are checked against
 * the course list, names that match an existing topic reuse its exact name, and two topics with the
 * same name are merged. Exported for tests.
 */
export function resolvePlan(
  raw: RawPlan,
  used: Passage[],
  courses: { id: string; name: string }[],
  sessionCourseId: string,
  existing: { courseId: string; title: string }[],
): TopicPlan[] {
  const byKey = new Map<string, TopicPlan>();
  for (const t of raw.topics ?? []) {
    const title = titleCase(t.title ?? "").slice(0, 80);
    if (!title || !topicKey(title)) continue;
    const c = (t.course ?? "").trim().toLowerCase();
    const course = courses.find((x) => x.id.toLowerCase() === c || x.name.toLowerCase() === c);
    const courseId = course?.id ?? sessionCourseId;
    const ids = (t.passages ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= used.length).map((n) => used[n - 1].id);
    if (!ids.length) continue;
    const match = existing.find((e) => e.courseId === courseId && topicKey(e.title) === topicKey(title));
    const key = `${courseId}|${topicKey(title)}`;
    const plan = byKey.get(key) ?? { title: match?.title ?? title, courseId, passageIds: [], existing: !!match };
    plan.passageIds = [...new Set([...plan.passageIds, ...ids])];
    byKey.set(key, plan);
  }
  return [...byKey.values()].slice(0, 3);
}

export async function planTopics(
  passages: Passage[],
  courses: { id: string; name: string }[],
  sessionCourseId: string,
  existing: { courseId: string; title: string }[],
  cfg: AiConfig = DEFAULT_AI,
): Promise<TopicPlan[]> {
  const { text, used } = numbered(passages, 24_000);
  const sessionCourse = courses.find((c) => c.id === sessionCourseId)?.name ?? sessionCourseId;
  const known = courses
    .map((c) => {
      const titles = existing.filter((e) => e.courseId === c.id).map((e) => `"${e.title}"`);
      return `- ${c.name}${titles.length ? `: existing topics ${titles.slice(0, 40).join(", ")}` : ""}`;
    })
    .join("\n");
  const raw = await chat<RawPlan>(cfg, {
    numCtx: 12_288,
    schema: PLAN_SCHEMA,
    messages: [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        content: `Below are numbered passages captured from a student's screen during one study session (they chose the course ${sessionCourse}).

Sort the study material into topics, the way a textbook divides a course into sections: 1 to 3 broad topics, each a short name of 1–5 words (e.g. "Strong Induction", "Sets and Subsets", "Limits of Sequences"). Prefer fewer, broader topics: related ideas (a definition, its proof method and its examples) belong in one topic. For each topic give the course it belongs to (by name, from the list below — usually ${sessionCourse}) and the numbers of the passages about it.
If the material fits a topic that already exists for that course, use that exact existing name instead of making a new one — even if the session only adds a little to it.
Leave out passages that aren't study material (web searches, videos, social media, email, menus, ads, garbled text).

Courses:
${known}

${text}`,
      },
    ],
  });
  return resolvePlan(raw, used, courses, sessionCourseId, existing);
}

// ---------- 2. notes ----------

const NOTES_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: NOTE_KINDS },
          title: { type: "string" },
          body: { type: "string" },
          source: { type: "integer" },
        },
        required: ["kind", "title", "body", "source"],
      },
    },
  },
  required: ["summary", "sections"],
};

type RawNotes = { summary?: string; sections?: { kind?: string; title?: string; body?: string; source?: number }[] };

const STOPWORDS = new Set(
  "the and for that this with what does from have how why can are was were when which into about there their then than your you these those will would should could them they also each such only some more most other must where while every given then thus hence".split(" "),
);

/**
 * Fixes LaTeX that JSON parsing mangled: "\\begin" read as a backspace + "egin", "\\text" as a tab +
 * "ext", or a doubled backslash ("\\\\frac") that would show up literally. Exported for tests.
 */
export function repairLatex(s: string): string {
  return s
    .replace(/\x08/g, "\\b")
    .replace(/\f/g, "\\f")
    .replace(/\t(?=[a-z])/g, "\\t")
    .replace(/\r(?=[a-z])/g, "\\r")
    .replace(/\\\\(?=[a-zA-Z])/g, "\\");
}

const TITLE_FILLER = new Set(["definition", "of", "the", "a", "an", "for", "and", "to", "in", "on", "with", "example", "examples", "formula", "theorem", "rule", "rules", "method", "notation"]);

/** Two section titles say the same thing ("Definition of Set Equality" ~ "Set Equality Definition"). Exported for tests. */
export function sameTitle(a: string, b: string): boolean {
  const words = (s: string) => new Set(topicKey(s).split(" ").filter((w) => w && !TITLE_FILLER.has(w)));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return topicKey(a) === topicKey(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / new Set([...x, ...y]).size >= 0.75;
}

/** Content words (4+ letters, not common words), lower-cased. */
function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/\p{L}{4,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
}

/**
 * How much of a note's wording appears in its source passage (0–1). Notes are reworded, so this is
 * only a guard against sections the model made up. Exported for tests.
 */
export function grounding(body: string, source: string): number {
  const words = contentWords(body);
  if (words.length < 4) return 1; // mostly math or very short: nothing to compare
  const have = new Set(contentWords(source).map((w) => w.slice(0, 5)));
  return words.filter((w) => have.has(w.slice(0, 5))).length / words.length;
}

/**
 * Keeps well-formed sections that come from a real passage, match its wording well enough, and
 * aren't already in the course's notes (`existingTitles`). Exported for tests.
 */
export function validateSections(raw: RawNotes["sections"], used: Passage[], existingTitles: string[] = []): NoteSectionDraft[] {
  const out: NoteSectionDraft[] = [];
  const seen = [...existingTitles];
  for (const s of raw ?? []) {
    const title = repairLatex((s.title ?? "").trim()).slice(0, 120);
    const body = repairLatex((s.body ?? "").trim());
    if (!title || !body) continue;
    if (!(Number.isInteger(s.source) && s.source! >= 1 && s.source! <= used.length)) continue;
    const passage = used[s.source! - 1];
    if (grounding(`${title} ${body}`, passage.text) < 0.3) continue;
    if (seen.some((t) => sameTitle(t, title))) continue;
    seen.push(title);
    const kind = NOTE_KINDS.includes(s.kind as NoteKind) ? (s.kind as NoteKind) : "point";
    out.push({ kind, title: ensureMathDelimiters(title), body: ensureMathDelimiters(body), passageId: passage.id });
  }
  return out.slice(0, 10);
}

export async function writeNotes(
  topic: string,
  course: string,
  passages: Passage[],
  existing: { summary: string; sectionTitles: string[] },
  cfg: AiConfig = DEFAULT_AI,
  context: { otherTopics?: string[]; courseTitles?: string[] } = {},
): Promise<TopicNotes> {
  const others = (context.otherTopics ?? []).filter((t) => topicKey(t) !== topicKey(topic));
  const { text, used } = numbered(passages, 20_000);
  const merging = existing.sectionTitles.length > 0;
  const raw = await chat<RawNotes>(cfg, {
    numCtx: 12_288,
    schema: NOTES_SCHEMA,
    messages: [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        content: `Write clean class notes on the topic "${topic}" (${course}) from the numbered passages below, which were captured from the student's screen (the text may have small reading errors — fix them).

Sections, each with a "kind":
- "definition": a key term and its exact meaning.
- "theorem": a theorem, principle or rule, stated precisely.
- "formula": an important formula or identity, with what its symbols mean.
- "example": a worked example from the passages, step by step.
- "mistake": a common mistake or pitfall the passages warn about (only if they do).
- "point": any other key idea, in one or two sentences.
Give each section a short title and a body. In worked examples, put each step on its own line. Write math in LaTeX between dollar signs, e.g. $P(k+1)$, $f_{k+1} = f_k + f_{k-1}$, $\\sum_{i=1}^{n} i$. Use Markdown for lists. Keep bodies short and clear; examples may be longer.
Every section must come from the passages: give the number of the passage it came from in "source". Don't add anything that isn't in the passages, and skip anything unrelated to "${topic}".${
  others.length ? ` These other topics get their own notes, so leave their material out: ${others.map((t) => `"${t}"`).join(", ")}.` : ""
}
${
  merging
    ? `These notes already exist for this topic, so only add NEW material — nothing that repeats these sections: ${existing.sectionTitles
        .slice(0, 60)
        .map((t) => `"${t}"`)
        .join(", ")}.
The current summary is: "${existing.summary}". Rewrite "summary" as one summary of the whole topic — what was already there and the new material together — in 2–3 sentences. Don't mention "new material" or "the passages".`
    : `Also write "summary": what this topic is about, in 2–3 sentences.`
}
If nothing in the passages is new or about this topic, return no sections.

${text}`,
      },
    ],
  });
  return {
    summary: repairLatex((raw.summary ?? "").trim()) || existing.summary,
    sections: validateSections(raw.sections, used, [...existing.sectionTitles, ...(context.courseTitles ?? [])]),
  };
}
