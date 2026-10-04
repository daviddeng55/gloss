// Turns plain-text math in AI summaries ("sqrt(xy)", "x^2", "(x+y)/2", "Σ_{i=m}^{k} x_i") into
// LaTeX ($...$) so it displays as real math. It only re-formats what's already written, word by word,
// so it can't change the meaning. Text already inside $...$ is left alone.

const MATHY = /\^|_|sqrt\(|√|[Σ∑]/;
/** "(x+y)/2", "n(n+1)/2", "1/2": a fraction with digits or brackets (so words like "and/or" stay). */
const FRACTION = /^([\w()+\-*]*\([\w+\-*]+\)[\w()]*|\d+)\/(\(?[\w+\-*]+\)?)$/;

function strip(s: string): string {
  return s.startsWith("(") && s.endsWith(")") && !s.slice(1, -1).includes(")") ? s.slice(1, -1) : s;
}

function toLatex(token: string): string {
  const frac = FRACTION.exec(token);
  if (frac) return `\\frac{${strip(frac[1])}}{${strip(frac[2])}}`;
  return token
    .replace(/sqrt\(([^()]*)\)/g, "\\sqrt{$1}")
    .replace(/√\(([^()]*)\)/g, "\\sqrt{$1}")
    .replace(/√(\w+)/g, "\\sqrt{$1}")
    .replace(/[Σ∑]/g, "\\sum ")
    .replace(/[·⋅]/g, "\\cdot ")
    .replace(/≤/g, "\\le ")
    .replace(/≥/g, "\\ge ")
    .replace(/≠/g, "\\ne ")
    .replace(/\^(\w)/g, "^{$1}")
    .replace(/_(\w)(?!\})/g, "_{$1}");
}

export function plainMathToLatex(text: string): string {
  // Split into $...$ parts (left alone) and plain parts (converted word by word).
  return text
    .split(/(\$\$[^$]*\$\$|\$[^$]*\$)/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/\S+/g, (word) => {
        const m = /^(.*?)([.,;:!?]*)$/.exec(word)!;
        let [, core, trail] = m;
        // Keep an unmatched closing bracket (end of a parenthetical) outside the math.
        while (core.endsWith(")") && (core.match(/\(/g) ?? []).length < (core.match(/\)/g) ?? []).length) {
          trail = ")" + trail;
          core = core.slice(0, -1);
        }
        let lead = "";
        while (core.startsWith("(") && (core.match(/\(/g) ?? []).length > (core.match(/\)/g) ?? []).length) {
          lead += "(";
          core = core.slice(1);
        }
        if (!core || !(MATHY.test(core) || FRACTION.test(core))) return word;
        return `${lead}$${toLatex(core)}$${trail}`;
      });
    })
    .join("");
}
