// Fixes a few math symbols that text recognition reliably misreads, using patterns that only
// occur in math (so ordinary sentences are left alone):
//   "n e N", "n E N", "n € N", "nEN"  ->  "n ∈ ℕ"      (also ℤ, ℚ, ℝ)
// Not C -> ℂ: in set theory "C" is usually a set's name (e.g. "n ∈ C"), not the complex numbers.
//   "Vn ∈ ℕ"                           ->  "∀n ∈ ℕ"
// It can't fix misreads that come out as ordinary text, like "a | b" read as "a band b".

const SETS: Record<string, string> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ" };

// Optional "V" (a misread "∀") stuck to a single-letter variable (or a list like "a, b"),
// then e/E/€/∈, then a capital set letter.
const MEMBERSHIP =
  /(?<![\p{L}\p{N}])(V(?=[a-z]))?([a-zA-Z](?:\s?,\s?[a-zA-Z])*)\s?(?:[eE€]|∈)\s?([NZQR])(?![\p{L}\p{N}])/gu;

export function fixMath(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(MEMBERSHIP, (m, forAll: string | undefined, vars: string, set: string, offset: number, whole: string) => {
    // Skip things like "Grade E N" or "Room E C": a lone capital right after another capitalised word.
    if (/^[A-Z]$/.test(vars) && /[A-Z][a-z]*\s$/.test(whole.slice(Math.max(0, offset - 8), offset))) return m;
    count++;
    return `${forAll ? "∀" : ""}${vars} ∈ ${SETS[set]}`;
  });
  return { text: out, count };
}
