// The learner model: how well you know each concept, how sure we are, and what kind of help works for
// you. Plain, explainable rules (not the AI's opinion), so you can always see why a number changed.
//
// Evidence about a concept:
//   covered — you studied it in a session (small start, no proof you understood it)
//   quiz    — you answered a quiz question on it (right or wrong): the strongest signal
//   ask     — you asked about it; the highest hint level you needed says how stuck you were
//   explain — you explained it to your Study Buddy: solid, or with a gap (weaker than a quiz answer)
//   manual  — you told us ("I know this" / "I don't")
//
// Mastery fades if you don't practise: it halves after a "half-life" that starts at 3 days and doubles
// with each correct answer (up to 60 days) — the same idea as spaced repetition.

export type HintLevelName = "nudge" | "explain" | "example";

export type Evidence = {
  at: string;
  kind: "covered" | "quiz" | "ask" | "explain" | "manual";
  correct?: boolean; // quiz; explain: true = solid explanation; manual: true = "I know this", false = "I don't"
  hintLevel?: HintLevelName; // ask: highest level you needed
};

export type ConceptState = {
  mastery: number; // 0–1, before fading
  current: number; // 0–1, after fading (what we show and use)
  confidence: number; // 0–1, how much evidence there is
  halfLifeDays: number;
  lastPracticedAt?: string;
  helps: Record<HintLevelName, number>; // which help level preceded getting it right
  quizzes: { right: number; wrong: number };
  explained: { solid: number; gaps: number };
  asks: number;
  why: string[]; // short, readable reasons for the current number
};

const DAY = 86_400_000;
const LEVELS: HintLevelName[] = ["nudge", "explain", "example"];

/** Works out a concept's state from its evidence, as of `now`. */
export function conceptState(evidence: Evidence[], now = Date.now()): ConceptState {
  const sorted = [...evidence].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let mastery = 0;
  let halfLife = 3;
  let weight = 0; // evidence weight, for confidence
  let lastPracticed: number | undefined;
  const helps: Record<HintLevelName, number> = { nudge: 0, explain: 0, example: 0 };
  const quizzes = { right: 0, wrong: 0 };
  const explained = { solid: 0, gaps: 0 };
  let asks = 0;
  let pendingHelp: HintLevelName | null = null; // the help you got, waiting to see if it worked
  let override: boolean | null = null;
  const why: string[] = [];

  for (const e of sorted) {
    const t = Date.parse(e.at);
    // Fade what you had up to this moment before applying new evidence.
    if (lastPracticed !== undefined) mastery *= Math.pow(0.5, (t - lastPracticed) / DAY / halfLife);
    if (e.kind === "covered") {
      if (mastery < 0.25) mastery = 0.25; // studied it: some familiarity
      weight += 0.25;
      lastPracticed = Math.max(lastPracticed ?? t, t);
    } else if (e.kind === "quiz") {
      if (e.correct) {
        mastery += (1 - mastery) * 0.35;
        halfLife = Math.min(60, halfLife * 2);
        quizzes.right++;
        if (pendingHelp) helps[pendingHelp]++;
      } else {
        mastery -= mastery * 0.4;
        halfLife = Math.max(3, halfLife / 2);
        quizzes.wrong++;
      }
      pendingHelp = null;
      weight += 1;
      lastPracticed = t;
    } else if (e.kind === "explain") {
      // Explaining it in your own words is good evidence, but a chat is looser than a quiz question.
      if (e.correct) {
        mastery += (1 - mastery) * 0.25;
        halfLife = Math.min(60, halfLife * 1.5);
        explained.solid++;
      } else {
        mastery -= mastery * 0.2;
        explained.gaps++;
      }
      weight += 0.75;
      lastPracticed = t;
    } else if (e.kind === "ask") {
      asks++;
      const level = e.hintLevel ?? "nudge";
      // Needing only a nudge is a good sign; needing a worked example means it was hard.
      if (level === "nudge") mastery += (1 - mastery) * 0.05;
      else if (level === "explain") mastery -= mastery * 0.1;
      else mastery -= mastery * 0.2;
      pendingHelp = level;
      weight += 0.5;
      lastPracticed = t;
    } else if (e.kind === "manual") {
      override = e.correct ?? null;
      weight += 1;
      lastPracticed = t;
    }
  }

  const days = lastPracticed !== undefined ? (now - lastPracticed) / DAY : 0;
  let current = mastery * Math.pow(0.5, days / halfLife);
  if (override === true) {
    current = Math.max(current, 0.9);
    mastery = Math.max(mastery, 0.9);
    why.push("You marked this as known.");
  } else if (override === false) {
    current = Math.min(current, 0.15);
    mastery = Math.min(mastery, 0.15);
    why.push("You marked this as not known yet.");
  }
  if (quizzes.right + quizzes.wrong) why.push(`Quiz: ${quizzes.right} right, ${quizzes.wrong} wrong.`);
  if (explained.solid + explained.gaps) {
    why.push(`Explained to your Study Buddy: ${explained.solid} solid, ${explained.gaps} with a gap.`);
  }
  if (asks) why.push(`You asked about it ${asks} time${asks === 1 ? "" : "s"}.`);
  if (days >= 1 && mastery - current > 0.05) {
    why.push(`Not practised for ${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}, so it has faded a little.`);
  }
  if (!why.length) why.push("You've studied it but haven't been quizzed on it yet.");

  return {
    mastery: clamp01(mastery),
    current: clamp01(current),
    confidence: clamp01(1 - Math.pow(0.5, weight)),
    halfLifeDays: halfLife,
    lastPracticedAt: lastPracticed !== undefined ? new Date(lastPracticed).toISOString() : undefined,
    helps,
    quizzes,
    explained,
    asks,
    why,
  };
}

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x));
}

/**
 * Which help level to start with when you ask about a concept.
 * - Already asked about this concept today (or the last help didn't work)? Go one level further than
 *   last time: a different approach instead of repeating.
 * - Otherwise use what has worked for you on this concept, then what works for you in general.
 * - With no history, pitch by mastery: weak concepts start with an explanation.
 */
export function chooseHintLevel(opts: {
  concept?: ConceptState;
  overall: Record<HintLevelName, number>;
  lastLevelThisSession?: HintLevelName;
}): { level: HintLevelName; reason: string } {
  const { concept, overall, lastLevelThisSession } = opts;
  if (lastLevelThisSession) {
    const next = LEVELS[Math.min(LEVELS.indexOf(lastLevelThisSession) + 1, LEVELS.length - 1)];
    return { level: next, reason: "You asked about this already today, so here's a different approach." };
  }
  const best = (h: Record<HintLevelName, number>) => {
    const total = h.nudge + h.explain + h.example;
    if (total < 2) return null;
    return LEVELS.reduce((a, b) => (h[b] > h[a] ? b : a));
  };
  const fromConcept = concept ? best(concept.helps) : null;
  if (fromConcept) return { level: fromConcept, reason: `${label(fromConcept)} has helped you most with this before.` };
  if (concept && concept.confidence > 0.3 && concept.current < 0.35) {
    return { level: "explain", reason: "You've found this one hard, so starting with the concept." };
  }
  const fromOverall = best(overall);
  if (fromOverall && fromOverall !== "nudge") {
    return { level: fromOverall, reason: `${label(fromOverall)} tends to help you most.` };
  }
  return { level: "nudge", reason: "" };
}

function label(level: HintLevelName) {
  return level === "nudge" ? "A nudge" : level === "explain" ? "Explaining the concept" : "A worked example";
}

/** Normalizes a concept name for matching ("Strong Induction." -> "strong induction"). */
export function conceptKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");
}

/** Days until a quiz question should come back, by spaced repetition adjusted for the concept's mastery. */
export function reviewIntervalDays(correct: boolean, previousInterval: number, conceptCurrent?: number): number {
  if (!correct) return 0; // next session
  const steps = [3, 7, 14];
  const next = steps.find((d) => d > previousInterval) ?? 14;
  // A concept that's fading fast comes back sooner.
  return conceptCurrent !== undefined && conceptCurrent < 0.4 ? Math.max(1, Math.round(next / 2)) : next;
}
