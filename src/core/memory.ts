// Course memory: finds the passages (from any session of a course) most related to a question.
// With the embedding model it matches by meaning; without it, by shared words (weighted so that rare,
// specific words like "induction" count more than common ones).
import { cosine, type Passage } from "./ai.ts";

export type MemoryPassage = Passage & { sessionId: string; startedAt: string; embedding?: Float32Array };

const STOP = new Set(
  "the and for that this with what does from have how why can are was were when which into about there their then than your you these those will would should could them they also only just such some each other more most very here where while because been being does done".split(" "),
);

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** Word-overlap score with inverse document frequency (a light BM25). */
function keywordScores(query: string, passages: MemoryPassage[]): number[] {
  const q = [...new Set(words(query))];
  if (!q.length) return passages.map(() => 0);
  const docs = passages.map((p) => new Set(words(p.text)));
  const df = new Map(q.map((w) => [w, docs.filter((d) => d.has(w)).length]));
  return docs.map((d, i) => {
    let score = 0;
    for (const w of q) if (d.has(w)) score += Math.log(1 + passages.length / (df.get(w)! || 1));
    // Prefer focused passages over very long ones a little.
    return score / Math.sqrt(1 + passages[i].text.length / 1500);
  });
}

/**
 * The best-matching passages for `query`. `queryEmbedding` (if given) is compared with each passage's
 * stored embedding; passages without one fall back to word matching.
 */
export function searchPassages(
  query: string,
  passages: MemoryPassage[],
  opts: { queryEmbedding?: number[]; limit?: number; minScore?: number } = {},
): (MemoryPassage & { score: number })[] {
  const limit = opts.limit ?? 3;
  const kw = keywordScores(query, passages);
  const maxKw = Math.max(1e-9, ...kw);
  const scored = passages.map((p, i) => {
    const byMeaning = opts.queryEmbedding && p.embedding ? cosine(opts.queryEmbedding, p.embedding) : undefined;
    // Meaning when we have it (0–1, ~0.5+ is related); otherwise words, scaled to a similar range.
    const score = byMeaning !== undefined ? byMeaning : (kw[i] / maxKw) * 0.7;
    return { ...p, score };
  });
  return scored
    .filter((p) => p.score >= (opts.minScore ?? (opts.queryEmbedding ? 0.45 : 0.2)))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Which known concept a question is about, by name words (or meaning, with embeddings). */
export function matchConcept(
  question: string,
  concepts: { id: string; name: string; embedding?: Float32Array }[],
  queryEmbedding?: number[],
): string | null {
  let best: { id: string; score: number } | null = null;
  const q = new Set(words(question));
  for (const c of concepts) {
    let score: number;
    if (queryEmbedding && c.embedding) score = cosine(queryEmbedding, c.embedding);
    else {
      const cw = words(c.name);
      score = cw.length ? cw.filter((w) => q.has(w) || [...q].some((x) => x.startsWith(w.slice(0, 5)) && w.length > 5)).length / cw.length : 0;
    }
    if (!best || score > best.score) best = { id: c.id, score };
  }
  const threshold = queryEmbedding ? 0.55 : 0.5;
  return best && best.score >= threshold ? best.id : null;
}
