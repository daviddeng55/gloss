// Redaction filter: runs on every piece of text before it is stored (and, later, before it's sent to any AI).

// SIN and PIN only match in capitals, so "sin x" in calculus notes is left alone.
const SENSITIVE_WORDS = /\b(?:(?:[Pp]assword|[Pp]asscode|[Pp]asswd|[Ss]ocial [Ii]nsurance|[Ss]ecurity [Cc]ode|PASSWORD|CVV|CVC)|SIN|PIN)\b/;

/** Card-like numbers: 4 groups of 4 (or similar) digits separated by spaces or dashes. */
const CARD_LIKE = /\b\d{4}[ -]\d{4,6}[ -]\d{4,5}(?:[ -]\d{1,4})?\b/g;
/** SIN / phone-like groups: 3-3-3 or 3-3-4 digits with separators. */
const GROUPED_DIGITS = /\b\d{3}[ -]\d{3}[ -]\d{3,4}\b/g;
/** Long unbroken digit strings (9+), e.g. account or card numbers typed without spaces. */
const LONG_DIGITS = /\b\d{9,}\b/g;

export const REDACTED = "[redacted]";

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  const swap = () => {
    count++;
    return REDACTED;
  };
  const lines = text.split("\n").map((line) => {
    let out = line.replace(CARD_LIKE, swap).replace(GROUPED_DIGITS, swap).replace(LONG_DIGITS, swap);
    // Text near a sensitive word: keep the word itself, hide whatever follows it on that line.
    const m = SENSITIVE_WORDS.exec(out);
    if (m) {
      const end = m.index + m[0].length;
      const rest = out.slice(end);
      if (rest.trim().replace(/^[:=\s-]+/, "").length > 0) {
        out = out.slice(0, end) + " " + REDACTED;
        count++;
      }
    }
    return out;
  });
  return { text: lines.join("\n"), count };
}
