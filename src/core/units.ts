// Units: a course's topics grouped under general headings, like a textbook's chapters (MATH 135 → "Induction"
// → Strong Induction, Principle of Induction). The AI sorts topics that aren't in a unit yet; you can rename
// units and move topics, and the AI never undoes that (moved topics are locked, renamed units keep their name).
import { chat, DEFAULT_AI, TUTOR_RULES, type AiConfig } from "./ai.ts";
import { conceptKey } from "./learner.ts";
import { titleCase } from "./notes.ts";

/** Unit names are matched by this key, so "Sets" and "sets." are one unit. */
export const unitKey = conceptKey;

const UNITS_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: { topic: { type: "integer" }, unit: { type: "string" } },
        required: ["topic", "unit"],
      },
    },
  },
  required: ["assignments"],
};

type RawUnits = { assignments?: { topic?: number; unit?: string }[] };

/** Which unit (by name) each topic goes in; `existing` says the name matched a unit that's already there. */
export type UnitAssignment = { topicId: string; unit: string; existing: boolean };

/**
 * Turns the model's reply into assignments: topic numbers become ids (only the topics that were asked about),
 * and a unit name that matches an existing unit reuses its exact name. Exported for tests.
 */
export function resolveUnits(raw: RawUnits, todo: { id: string }[], units: { title: string }[]): UnitAssignment[] {
  const out: UnitAssignment[] = [];
  for (const a of raw.assignments ?? []) {
    const topic = Number.isInteger(a.topic) && a.topic! >= 1 && a.topic! <= todo.length ? todo[a.topic! - 1] : null;
    const name = titleCase(String(a.unit ?? "").replace(/^unit\s*\d*\s*[:.-]?\s*/i, "")).slice(0, 60);
    if (!topic || !unitKey(name) || out.some((o) => o.topicId === topic.id)) continue;
    const match = units.find((u) => unitKey(u.title) === unitKey(name));
    out.push({ topicId: topic.id, unit: match?.title ?? name, existing: !!match });
  }
  return out;
}

/**
 * Asks the model to put `todo` (topics without a unit) into units of the course: existing ones where they fit,
 * else new general headings. `placed` are the topics already in units, so it sees how the course is divided.
 */
export async function planUnits(
  course: string,
  units: { title: string; topics: string[] }[],
  todo: { id: string; title: string; summary: string }[],
  cfg: AiConfig = DEFAULT_AI,
): Promise<UnitAssignment[]> {
  if (!todo.length) return [];
  const current = units.length
    ? units.map((u) => `- ${u.title}${u.topics.length ? `: ${u.topics.map((t) => `"${t}"`).join(", ")}` : ""}`).join("\n")
    : "(none yet)";
  const list = todo.map((t, i) => `${i + 1}. ${t.title}${t.summary ? ` — ${t.summary.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n");
  const raw = await chat<RawUnits>(cfg, {
    schema: UNITS_SCHEMA,
    temperature: 0,
    timeoutMs: 120_000,
    messages: [
      { role: "system", content: TUTOR_RULES },
      {
        role: "user",
        content: `These are topics from a student's notes for ${course}. Group them into units, the way a textbook groups sections into chapters.

Units the course already has (with their topics):
${current}

Put each numbered topic below into a unit. Use an existing unit's exact name when the topic fits it. Otherwise make a new unit: a general heading of 1–3 words that could hold several topics (e.g. "Induction", "Sets", "Logic", "Limits", "Course Information") — never just the topic's own name, unless nothing broader fits. Aim for a few broad units, not one per topic.
Return one assignment per topic: its number in "topic" and the unit name in "unit".

Topics:
${list}`,
      },
    ],
  });
  return resolveUnits(raw, todo, units);
}
