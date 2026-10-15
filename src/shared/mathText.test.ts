import assert from "node:assert/strict";
import { test } from "node:test";
import { notesMarkdown, plainMathToLatex } from "./mathText.ts";

test("plain-text math in summaries becomes LaTeX", () => {
  const cases: [string, string][] = [
    ["the geometric mean sqrt(xy).", "the geometric mean $\\sqrt{xy}$."],
    ["the arithmetic mean (x+y)/2 is", "the arithmetic mean $\\frac{x+y}{2}$ is"],
    ["by showing (x-y)^2=0.", "by showing $(x-y)^{2}=0$."],
    ["then 3a^2 + 4a - 1 is odd", "then $3a^{2}$ + 4a - 1 is odd"],
    ["sums like Σ_{i=m}^{k} x_i, where", "sums like $\\sum _{i=m}^{k}$ $x_{i}$, where"],
    ["constants (c·Σx_i = cΣx_i) and", "constants ($c\\cdot \\sum x_{i}$ = $c\\sum x_{i}$) and"],
    ["equals n(n+1)/2 here", "equals $\\frac{n(n+1)}{2}$ here"],
  ];
  for (const [input, want] of cases) assert.equal(plainMathToLatex(input), want);
});

test("ordinary text and existing LaTeX are left alone", () => {
  for (const s of ["The proof uses and/or logic.", "It is $x^2$ already.", "Chapter 4.1, page 2", "x=y implies equality"]) {
    assert.equal(plainMathToLatex(s), s);
  }
});

test("bracketed exponents and subscripts are raised or lowered whole", () => {
  assert.equal(plainMathToLatex("2^(k-1) < 2^(k+1)"), "$2^{k-1}$ < $2^{k+1}$");
  assert.equal(plainMathToLatex("f_(k+1) = f_k + f_(k-1)"), "$f_{k+1}$ = $f_{k}$ + $f_{k-1}$");
});

test("notes: display formulas get their own lines and steps keep their line breaks", () => {
  assert.equal(
    notesMarkdown("Substitute:\n$$3a^2 = 12k^2$$\nSimplify:\nso it is odd."),
    "Substitute:\n\n$$\n3a^2 = 12k^2\n$$\n\nSimplify:  \nso it is odd.",
  );
});
