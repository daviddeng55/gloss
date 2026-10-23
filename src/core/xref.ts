// Cross-references between notes: key terms (definition and theorem titles, topic titles) that appear in
// other topics' notes — in the same course or another — become links to where they're explained. Only named
// terms are linked, never ordinary words. Pure functions; the results are cached in the database (main/xref.ts).

export type XrefTopic = {
  id: string;
  courseId: string;
  title: string;
  summary: string;
  sections: { id: string; kind: string; title: string; body: string }[];
};

/** A term and where it's explained. */
export type Term = { key: string; text: string; topicId: string; sectionId?: string };

/** One link: the words as written (`text`) in a section (or the topic summary) and where they lead. */
export type Xref = { text: string; topicId: string; sectionId?: string };

/** Per topic: links by section id ("summary" for the topic summary). */
export type TopicXrefs = Record<string, Xref[]>;

// Words that are too general to be worth a link on their own, even as a definition's title.
const GENERIC = new Set(
  `proof proofs theorem theorems lemma definition definitions example examples note notes idea ideas method methods rule rules
  result results case cases step steps fact facts property properties statement statements formula formulas problem problems
  number numbers value values function functions set sets list lists term terms example summary overview introduction review
  condition conditions notation format standard basic basics general key important main simple common mistake mistakes`.split(/\s+/),
);

/** "Principle of Strong Induction (POSI)" → ["Principle of Strong Induction", "POSI"]; drops generic tails. */
export function termTexts(title: string): string[] {
  let t = title.replace(/\$[^$]*\$/g, " ").replace(/\s+/g, " ").trim();
  const abbr = /\(([A-Z][A-Z0-9-]{1,9})\)\s*$/.exec(t)?.[1];
  t = t.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^(definition|the definition|def\.?)\s+of\s+/i, "").replace(/\s+(via|using|in terms of|for)\s+.*$/i, "");
  t = t.replace(/\s+(relationship|definition|condition|conditions)$/i, "").trim();
  const out: string[] = [];
  if (t && t.split(" ").length <= 6) out.push(t);
  if (abbr) out.push(abbr);
  return out;
}

/** Is this worth linking? Not a common word, not too short, and made of real words. */
export function meaningful(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (/^[A-Z][A-Z0-9-]{1,9}$/.test(text)) return text.replace(/[^A-Z]/g, "").length >= 3; // abbreviations like POSI, AM-GM
  if (!/[a-z]/i.test(text)) return false;
  if (words.length === 1) return words[0].length >= 5 && !GENERIC.has(words[0]) && !GENERIC.has(words[0].replace(/s$/, ""));
  return !words.every((w) => GENERIC.has(w) || w.length <= 3);
}

export const termKey = (s: string) => s.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();

/** Every linkable term in the notes: definition/theorem titles (→ that section) and topic titles (→ the topic). */
export function collectTerms(topics: XrefTopic[]): Term[] {
  const terms = new Map<string, Term>();
  const add = (text: string, topicId: string, sectionId?: string) => {
    const key = termKey(text);
    if (!meaningful(text) || terms.has(key)) return; // the first place a term is explained wins
    terms.set(key, { key, text, topicId, sectionId });
  };
  for (const t of topics) {
    for (const s of t.sections) {
      if (s.kind === "definition" || s.kind === "theorem") for (const x of termTexts(s.title)) add(x, t.id, s.id);
    }
  }
  for (const t of topics) for (const x of termTexts(t.title)) add(x, t.id);
  return [...terms.values()];
}

/** Text with math ($…$, $$…$$) and code (`…`) blanked out, same length, so terms inside them never match. */
function prose(text: string): string {
  return text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

function pattern(term: string): RegExp {
  const body = term
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-‐-―]"))
    .join("\\s+");
  // Whole words only; a plural "s"/"es" is fine.
  return new RegExp(`(?<![\\w-])${body}(?:e?s)?(?![\\w-])`, "i");
}

/**
 * The terms (explained in OTHER topics) that appear in `text`: the first occurrence of each, longest terms
 * first so "Principle of Strong Induction" wins over "Strong Induction", never overlapping, at most `max`.
 */
export function findTerms(text: string, terms: Term[], ownTopicId: string, max = 6): Xref[] {
  const plain = prose(text);
  const taken: [number, number][] = [];
  const found: (Xref & { at: number })[] = [];
  const targets = new Set<string>();
  for (const term of [...terms].sort((a, b) => b.text.length - a.text.length)) {
    if (term.topicId === ownTopicId || found.length >= max) continue;
    const target = `${term.topicId}/${term.sectionId ?? ""}`;
    if (targets.has(target)) continue; // one link per place is enough
    const m = pattern(term.text).exec(plain);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    taken.push([start, end]);
    targets.add(target);
    found.push({ text: text.slice(start, end), topicId: term.topicId, sectionId: term.sectionId, at: start });
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...x }) => x);
}

/**
 * Terms that turn up in more than half of all topics (once there are enough topics to tell) are as good as
 * common words in these notes: a link on every page helps nobody, so they're left out.
 */
export function dropEverywhereTerms(terms: Term[], topics: XrefTopic[]): Term[] {
  if (topics.length < 6) return terms;
  const texts = topics.map((t) => prose(`${t.title}\n${t.summary}\n${t.sections.map((s) => `${s.title}\n${s.body}`).join("\n")}`));
  return terms.filter((term) => texts.filter((x) => pattern(term.text).test(x)).length <= topics.length / 2);
}

/** All cross-references in the notes: for every topic, the links in its summary and each section. */
export function buildXrefs(topics: XrefTopic[]): Map<string, TopicXrefs> {
  const terms = dropEverywhereTerms(collectTerms(topics), topics);
  const out = new Map<string, TopicXrefs>();
  for (const t of topics) {
    const links: TopicXrefs = {};
    const summary = findTerms(t.summary, terms, t.id);
    if (summary.length) links.summary = summary;
    for (const s of t.sections) {
      const found = findTerms(`${s.body}`, terms, t.id);
      if (found.length) links[s.id] = found;
    }
    out.set(t.id, links);
  }
  return out;
}
