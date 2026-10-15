// "Find it": turns what you type into a full-text search query for SQLite's FTS5.
// (Full-text search keeps an index of every word, like the index at the back of a book, so finding
// the passages that contain some words is instant, without reading every passage.)

/** Marks the start and end of a matching word in snippets and highlighted text. */
export const MATCH_START = "\u0001";
export const MATCH_END = "\u0002";

/**
 * "strong induc" -> `"strong" "induc"*`: every word must appear (in any order), and the last word
 * may be unfinished, so results show up while you type. Punctuation and FTS5 syntax are ignored,
 * so nothing typed can break the query. Returns "" when there's nothing to search for.
 */
export function toFtsQuery(input: string): string {
  const words = (input.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

/** Splits highlighted text into plain and matching parts, for showing in a window. */
export function splitMatches(text: string): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  for (const piece of text.split(MATCH_START)) {
    const end = piece.indexOf(MATCH_END);
    if (end === -1) parts.push({ text: piece, match: false });
    else parts.push({ text: piece.slice(0, end), match: true }, { text: piece.slice(end + 1), match: false });
  }
  return parts.filter((p) => p.text);
}
