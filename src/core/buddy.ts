// Study Buddy: a small character who, after you finish a concept, asks you one question the way a
// curious classmate would ("wait, how does that work?"). Explaining something in your own words is one
// of the best ways to find out whether you really understand it.
//
// This file holds the rules for *when* the buddy may appear (plain logic, no AI, fully tested) and the
// two AI calls: thinking of a question, and reacting to your answer.
//
// When it may appear:
//   - only after you've spent a while on one concept (or page) and then moved on to something else,
//     so it never interrupts you mid-reading;
//   - only shortly after that move (not once you're reading the next thing);
//   - never while you're circling or asking, or right after, and never while you're typing;
//   - at most once every 15 minutes (adjustable), never twice about the same thing in a session;
//   - not while snoozed ("Not now"), paused for the session, or turned off.

import { chat, DEFAULT_AI, type AiConfig } from "./ai.ts";
import { conceptKey } from "./learner.ts";

export type BuddyCharacter = "dog" | "cat" | "penguin" | "birdie";
export const BUDDY_CHARACTERS: { id: BuddyCharacter; label: string; defaultName: string; voice: string }[] = [
  { id: "dog", label: "Dog", defaultName: "Biscuit", voice: "eager and warm, a little excitable" },
  { id: "cat", label: "Cat", defaultName: "Miso", voice: "calm, dry and quietly curious" },
  { id: "penguin", label: "Penguin", defaultName: "Pip", voice: "polite, earnest and a bit formal" },
  { id: "birdie", label: "Birdie", defaultName: "Wren", voice: "chirpy, quick and playful" },
];

export const isBuddyCharacter = (x: unknown): x is BuddyCharacter => BUDDY_CHARACTERS.some((c) => c.id === x);

// ---------- what you're on ----------

/** What you're studying right now: a known concept if the screen is clearly about one, else the page. */
export type Focus = {
  key: string; // "concept:<id>" or "page:<app|title>"
  label: string; // shown nowhere; used in the prompt ("strong induction", "Lecture 7 — Sets")
  page: string;
  conceptId?: string;
  text?: string; // what was read while on it (latest captures), for the question
  app?: string; // the app it was read in (fast mode only sends text from study apps)
};

/**
 * The known concept a screen's text is mostly about, if one clearly leads: its name appears at least
 * twice, and more often than any other. Short or generic names (under 4 letters) don't count.
 */
export function dominantConcept(text: string, concepts: { id: string; name: string }[]): { id: string; name: string } | null {
  const hay = ` ${conceptKey(text)} `;
  const counts = concepts
    .map((c) => {
      const key = conceptKey(c.name);
      if (key.replace(/\s/g, "").length < 4) return { c, n: 0 };
      let n = 0;
      for (let i = hay.indexOf(` ${key} `); i >= 0; i = hay.indexOf(` ${key} `, i + 1)) n++;
      return { c, n };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!counts.length || counts[0].n < 2 || counts[1]?.n === counts[0].n) return null;
  return counts[0].c;
}

/** The focus for a page and the text just read on it. */
export function focusFor(page: string, title: string, text: string, concepts: { id: string; name: string }[]): Focus {
  const c = text ? dominantConcept(text, concepts) : null;
  if (c) return { key: `concept:${c.id}`, label: c.name, page, conceptId: c.id, text };
  const label = title.replace(/\s*[-–—|]\s*(Google Chrome|Safari|Arc|Firefox|Preview|Adobe Acrobat.*)$/i, "").trim() || "this page";
  return { key: `page:${page}`, label, page, text };
}

// ---------- when to appear ----------

export type TriggerOptions = {
  /** Time on one focus before moving on counts as having finished it. */
  minDwellMs: number;
  /** At most one appearance per this long (the "every 15–20 minutes" setting). */
  cooldownMs: number;
  /** After moving on, wait this long (you might just be glancing at something)… */
  settleMs: number;
  /** …but no longer than this: after that you're reading the next thing. */
  graceMs: number;
  /** Gaps between checks longer than this (a pause, sleep) don't count as time spent. */
  maxStepMs: number;
  /** Stay away this long after you circle and ask. */
  quietAfterAskMs: number;
  /** You must have stopped typing/using the mouse for this long. */
  idleNeededMs: number;
  /** "Not now". */
  snoozeMs: number;
  /** Skip concepts you clearly know already (current mastery at or above this, with good confidence). */
  knownMastery: number;
};

export const DEFAULT_TRIGGER: TriggerOptions = {
  minDwellMs: 4 * 60_000,
  cooldownMs: 15 * 60_000,
  settleMs: 10_000,
  graceMs: 75_000,
  maxStepMs: 30_000,
  quietAfterAskMs: 2 * 60_000,
  idleNeededMs: 3_000,
  snoozeMs: 20 * 60_000,
  knownMastery: 0.85,
};

export type Candidate = { focus: Focus; dwellMs: number; finishedAt: number };

/** What else is going on, checked just before appearing. */
export type TriggerContext = {
  enabled: boolean;
  paused: boolean; // the session is paused
  asking: boolean; // circling, or an Ask popup is open
  lastAskAt: number; // when you last circled/asked (-Infinity if never)
  idleMs: number; // time since your last keystroke or mouse movement
  mastery?: (conceptId: string) => { current: number; confidence: number } | undefined;
};

export type Decision = { show: Candidate } | { wait: string } | { skip: string } | null;

export class BuddyTrigger {
  readonly opts: TriggerOptions;
  private current: { key: string; focus: Focus; lastAt: number } | null = null;
  private dwell = new Map<string, number>(); // time spent per focus this session
  private pending: Candidate | null = null;
  private asked = new Set<string>(); // focuses already asked about this session
  private lastShownAt = -Infinity;
  private snoozedUntil = -Infinity;
  private pausedForSession = false;

  constructor(opts: Partial<TriggerOptions> = {}) {
    this.opts = { ...DEFAULT_TRIGGER, ...opts };
  }

  /** Call once per screen check with what you're on. */
  observe(at: number, focus: Focus) {
    const cur = this.current;
    if (cur && cur.key === focus.key) {
      const step = Math.min(Math.max(0, at - cur.lastAt), this.opts.maxStepMs);
      this.dwell.set(cur.key, (this.dwell.get(cur.key) ?? 0) + step);
      cur.lastAt = at;
      cur.focus = { ...focus, text: focus.text || cur.focus.text };
      return;
    }
    // Moved on. Back to what we were about to ask about? Then it wasn't finished after all.
    if (this.pending?.focus.key === focus.key) this.pending = null;
    if (cur) {
      const spent = this.dwell.get(cur.key) ?? 0;
      if (spent >= this.opts.minDwellMs && !this.asked.has(cur.key)) {
        this.pending = { focus: cur.focus, dwellMs: spent, finishedAt: at };
      }
    }
    this.current = { key: focus.key, focus, lastAt: at };
  }

  /**
   * Should the buddy appear now? `show` = yes (then call `shown`); `wait` = not yet, maybe in a moment;
   * `skip` = this moment has passed; null = nothing finished.
   */
  decide(at: number, ctx: TriggerContext): Decision {
    const p = this.pending;
    if (!p) return null;
    const drop = (why: string): Decision => {
      this.pending = null;
      return { skip: why };
    };
    if (!ctx.enabled) return drop("turned off");
    if (this.pausedForSession) return drop("paused for this session");
    if (at < this.snoozedUntil) return drop("snoozed");
    if (at - this.lastShownAt < this.opts.cooldownMs) return drop("appeared recently");
    if (this.asked.has(p.focus.key)) return drop("already asked about this");
    if (p.focus.conceptId && ctx.mastery) {
      const m = ctx.mastery(p.focus.conceptId);
      if (m && m.current >= this.opts.knownMastery && m.confidence >= 0.5) return drop("you know this one well");
    }
    if (at - p.finishedAt > this.opts.graceMs) return drop("you're reading the next thing now");
    if (at - p.finishedAt < this.opts.settleMs) return { wait: "just moved on" };
    if (ctx.paused) return { wait: "session paused" };
    if (ctx.asking || at - ctx.lastAskAt < this.opts.quietAfterAskMs) return { wait: "circle and ask" };
    if (ctx.idleMs < this.opts.idleNeededMs) return { wait: "typing" };
    return { show: p };
  }

  /** The buddy appeared for this candidate. */
  shown(at: number, c: Candidate) {
    this.lastShownAt = at;
    this.asked.add(c.focus.key);
    if (this.pending === c) this.pending = null;
  }

  /** The question couldn't be made (e.g. the AI is busy): let this moment go without counting it. */
  dropPending() {
    this.pending = null;
  }

  /** "Not now": nothing for 20 minutes. */
  snooze(at: number) {
    this.snoozedUntil = at + this.opts.snoozeMs;
    this.pending = null;
  }

  /** "Pause for this session". */
  pauseForSession() {
    this.pausedForSession = true;
    this.pending = null;
  }

  get isPausedForSession() {
    return this.pausedForSession;
  }

  /** Time spent on a focus so far (for tests and logs). */
  dwellOn(key: string): number {
    return this.dwell.get(key) ?? 0;
  }
}

// ---------- the conversation ----------

/** Most follow-up questions after a shaky answer, before the buddy thanks you and leaves. */
export const MAX_FOLLOW_UPS = 2;

export type BuddyMood = "idle" | "asking" | "thinking" | "happy" | "confused" | "thanks";
/** `cloud`: a buddy line written by the cloud model (fast mode). */
export type BuddyTurn = { who: "buddy" | "you"; text: string; at: string; verdict?: "solid" | "gap"; cloud?: boolean };

/** What happens after the AI judges an answer. */
export function nextStep(verdict: "solid" | "gap", followUpsSoFar: number, followUp: string): { mood: BuddyMood; ask?: string; done: boolean } {
  if (verdict === "solid") return { mood: "happy", done: true };
  if (followUpsSoFar < MAX_FOLLOW_UPS && followUp.trim()) return { mood: "confused", ask: followUp.trim(), done: false };
  return { mood: "thanks", done: true };
}

/** In-character lines for the end of a chat (written here, not by the AI, so they're always kind). */
export function closingLine(character: BuddyCharacter, mood: "happy" | "thanks"): string {
  const lines: Record<BuddyCharacter, { happy: string; thanks: string }> = {
    dog: { happy: "Ohh, that makes so much sense! Thank you!", thanks: "Thanks for walking me through it! I'll go chew on that." },
    cat: { happy: "Hm. Yes. That's clicked for me now. Thanks.", thanks: "Thanks. I'll think about that one in a sunny spot." },
    penguin: { happy: "Splendid, that's very clear. Thank you!", thanks: "Thank you kindly — I'll waddle off and ponder it." },
    birdie: { happy: "Ooh! Got it, got it! Thanks!", thanks: "Thanks! I'll flutter off and think it over." },
  };
  return lines[character][mood];
}

const persona = (character: BuddyCharacter, name: string) => {
  const c = BUDDY_CHARACTERS.find((x) => x.id === character)!;
  return `You are ${name}, a ${c.label.toLowerCase()} who is the student's classmate in this course. Personality: ${c.voice}.
You are NOT a teacher, tutor or examiner. You're a curious classmate who just read the same material and wants the student to explain it to you.
Never grade, never say "correct", "wrong", "good job" or give a score, never quiz with options, never lecture.`;
};

const QUESTION_SCHEMA = {
  type: "object",
  properties: { question: { type: "string" }, concept: { type: "string" } },
  required: ["question", "concept"],
};

/**
 * One short question about what the student just finished, asked like a curious classmate.
 * `concept` is a short name for the idea asked about (reusing a known name when it fits).
 */
export async function buddyQuestion(
  req: { character: BuddyCharacter; name: string; course: string; focusLabel: string; text: string; knownConcepts: string[] },
  cfg: AiConfig = DEFAULT_AI,
): Promise<{ question: string; concept: string }> {
  const out = await chat<{ question?: string; concept?: string }>(cfg, {
    schema: QUESTION_SCHEMA,
    temperature: 0.6,
    timeoutMs: 60_000,
    messages: [
      { role: "system", content: persona(req.character, req.name) },
      {
        role: "user",
        content: `Course: ${req.course}. The student just finished reading about: ${req.focusLabel}.

What they read (from their screen; symbols may be misread):
${req.text.slice(0, 2500)}

Write ONE short question (at most 25 words) asking them to explain the main idea to you in their own words — casual and curious, like "Wait, why does … work?" or "How would you explain … to me?". Ask about the idea, not a fact to recall, and not about a specific example number or page.
"concept": a short name (2–5 words) for the idea you asked about.${req.knownConcepts.length ? ` Reuse one of these names if it fits: ${req.knownConcepts.slice(0, 40).join("; ")}.` : ""}`,
      },
    ],
  });
  const question = cleanLine(out.question ?? "");
  if (!question || question.length > 220) throw new Error("The buddy's question came out wrong.");
  return { question: question.endsWith("?") ? question : `${question.replace(/[.!]+$/, "")}?`, concept: cleanLine(out.concept ?? "").slice(0, 80) || req.focusLabel };
}

const REACT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["solid", "gap"] }, followUp: { type: "string" } },
  required: ["verdict", "followUp"],
};

/**
 * Judges the student's explanation against what they read: "solid" if it gets the key idea right
 * (wording and detail can differ), "gap" if it's wrong, vague or missing the key idea. For a gap,
 * `followUp` is one gentle, curious question that nudges toward what's missing (never the answer).
 * The verdict is never shown; it only picks the buddy's reaction and updates the learner model.
 */
export async function buddyReact(
  req: { character: BuddyCharacter; name: string; course: string; text: string; turns: BuddyTurn[] },
  cfg: AiConfig = DEFAULT_AI,
): Promise<{ verdict: "solid" | "gap"; followUp: string }> {
  const chatLog = req.turns.map((t) => `${t.who === "buddy" ? req.name : "Student"}: ${t.text}`).join("\n");
  const out = await chat<{ verdict?: string; followUp?: string }>(cfg, {
    schema: REACT_SCHEMA,
    temperature: 0.2,
    timeoutMs: 60_000,
    messages: [
      { role: "system", content: persona(req.character, req.name) },
      {
        role: "user",
        content: `Course: ${req.course}. The material the student read (from their screen; symbols may be misread):
${req.text.slice(0, 2500)}

Your chat so far:
${chatLog}

Judge the student's latest explanation using the material.
"verdict": "solid" if it captures the key idea correctly (it can be informal, short or use different words or notation). "gap" if it's wrong, too vague to show understanding, or misses the key idea. "I don't know" is a gap.
"followUp": if "gap", ONE short, friendly question (at most 25 words) as a curious classmate, that points them toward what's missing without giving the answer or saying they were wrong (e.g. "Hmm, but what happens when …?"). If "solid", "".`,
      },
    ],
  });
  const verdict = out.verdict === "solid" ? "solid" : "gap";
  return { verdict, followUp: verdict === "gap" ? cleanLine(out.followUp ?? "").slice(0, 220) : "" };
}

function cleanLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "").trim();
}
