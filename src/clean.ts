// Turns raw text-recognition output into clean paragraphs:
//   1. drop UI noise (menu bar, buttons, clock, URLs, low-confidence junk)
//   2. group lines into paragraphs
//   3. drop text already seen earlier in the session (exact or near-duplicate)
import type { TextBlock } from "./helper.ts";

export type CleanStats = { linesIn: number; noise: number; duplicate: number; kept: number };

// Single words/short phrases that are almost always buttons, menus or toolbar labels.
const UI_WORDS = new Set([
  "file", "edit", "view", "history", "bookmarks", "window", "help", "share", "cancel", "ok", "done",
  "save", "open", "close", "back", "forward", "reload", "refresh", "search", "menu", "home", "more",
  "settings", "reply", "like", "follow", "subscribe", "download", "upload", "print", "copy", "paste",
  "undo", "redo", "zoom", "next", "previous", "prev", "submit", "go", "format", "insert", "tools",
  "extensions", "profiles", "tab", "favorites", "sidebar", "dismiss", "allow", "block",
  "new tab", "new window", "sign in", "log in", "sign out", "log out", "zoom in", "zoom out", "go to",
  "skip to main content", "reading list", "not now", "learn more", "accept all", "reject all",
]);

// Browser and toolbar labels seen in real sessions.
const BROWSER_CHROME =
  /^(ask (gemini|google)|all bookmarks|\+ ?ask google|ai mode|add shortcut|customi[sz]e chrome|finish update|relaunch to update|automatic zoom|of \d+|page \d+ of \d+)$/;

const CLOCK = /^\d{1,2}:\d{2}(:\d{2})?\s*([ap]\.?m\.?)?$/i;
const PERCENT = /^\d{1,3}\s?%$/;
const URL_ONLY = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i;

const MATH_SIGN = /[=<>≤≥≠]|\b\w ?\| ?\w\b/; // comparisons, or "a | b" (divides)

export function isNoiseLine(line: string): boolean {
  const t = line.trim();
  const alnum = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  // Fragments like "inG", "D2L", "10 c*", "PM": too short to mean anything, unless it's math like "x = 1".
  if (alnum < 4 && !MATH_SIGN.test(t)) return true;
  // Garbled recognition, e.g. "22[ +1 = 2[2[[[3]" = 10 •51 [ =]": lots of stray brackets or #.
  if ((t.match(/[[\]{}#]/g) ?? []).length >= 4) return true;
  const lower = t.toLowerCase().replace(/[.:…>›»]+$/, "").trim();
  if (UI_WORDS.has(lower) || BROWSER_CHROME.test(lower)) return true;
  // PDF viewer toolbar: page counter "6 / 36" or zoom "100%" with hardly any words around it.
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if ((/^\d+ \/ \d+(\s|$)/.test(t) || /\b\d{2,3}\s?%/.test(t)) && letters < 4) return true;
  if (CLOCK.test(t) || PERCENT.test(t)) return true;
  if (URL_ONLY.test(t) && !t.includes(" ")) return true;
  return false;
}

/**
 * Comparison key: lowercase letters and digits only, with look-alike characters folded together,
 * so "10 • 5' = 18" and "10-5º =18" (the same line read twice) compare as equal or nearly so.
 */
export function lineKey(line: string): string {
  return line
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[º°]/g, "o")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/[il|!]/g, "1")
    .replace(/o/g, "0")
    .replace(/[кκ]/g, "k");
}

function trigrams(s: string): Set<string> {
  const g = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) g.add(s.slice(i, i + 3));
  return g;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** Edit distance between a and b, giving up (returning max + 1) once it must exceed `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Two keys are the same line read twice if at most ~15% of characters differ (OCR jitter, not a different line). */
export function similarKeys(a: string, b: string): boolean {
  const max = Math.floor(Math.max(a.length, b.length) * 0.15);
  return editDistance(a, b, max) <= max;
}

/** Group single lines (from the "lines" engine) into paragraphs by vertical spacing and left edge. */
export function groupLines(blocks: TextBlock[]): TextBlock[] {
  const sorted = [...blocks].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const out: TextBlock[] = [];
  let cur: { lines: TextBlock[]; bottom: number; x: number; lineH: number } | null = null;
  for (const b of sorted) {
    const gap = cur ? b.box.y - cur.bottom : Infinity;
    const sameColumn = cur ? Math.abs(b.box.x - cur.x) < 0.08 : false;
    if (cur && sameColumn && gap < cur.lineH * 0.9 && gap > -cur.lineH * 0.5) {
      cur.lines.push(b);
      cur.bottom = Math.max(cur.bottom, b.box.y + b.box.h);
    } else {
      if (cur) out.push(merge(cur.lines));
      cur = { lines: [b], bottom: b.box.y + b.box.h, x: b.box.x, lineH: b.box.h };
    }
  }
  if (cur) out.push(merge(cur.lines));
  return out;
}

function merge(lines: TextBlock[]): TextBlock {
  const x = Math.min(...lines.map((l) => l.box.x));
  const y = Math.min(...lines.map((l) => l.box.y));
  const r = Math.max(...lines.map((l) => l.box.x + l.box.w));
  const b = Math.max(...lines.map((l) => l.box.y + l.box.h));
  return {
    text: lines.map((l) => l.text).join("\n"),
    confidence: Math.min(...lines.map((l) => l.confidence)),
    box: { x, y, w: r - x, h: b - y },
  };
}

type Seen = { key: string; grams: Set<string> };

const BROWSERS = new Set([
  "com.google.chrome",
  "com.apple.safari",
  "company.thebrowser.browser", // Arc
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "com.brave.browser",
]);

export class TextCleaner {
  private exact = new Set<string>();
  private recent: Seen[] = []; // for near-duplicate checks
  private readonly maxRecent = 3000;

  private opts: { engine: "lines" | "document"; mode: "window" | "display"; minConfidence: number };

  constructor(opts: { engine: "lines" | "document"; mode: "window" | "display"; minConfidence: number }) {
    this.opts = opts;
  }

  /** Returns the paragraphs worth keeping from one capture, in reading order. */
  clean(
    blocks: TextBlock[],
    win: { bundleId: string; height: number } = { bundleId: "", height: 0 },
  ): { paragraphs: string[]; stats: CleanStats } {
    const stats: CleanStats = { linesIn: 0, noise: 0, duplicate: 0, kept: 0 };

    let usable = blocks.filter((b) => {
      // In full-display mode the top ~3.5% is the macOS menu bar.
      if (this.opts.mode === "display" && b.box.y + b.box.h < 0.035) return false;
      if (this.opts.mode === "window") {
        // Tabs, address bar and bookmarks bar (browsers, ~105 pt), or a toolbar (other apps, ~40 pt).
        const chromePt = BROWSERS.has(win.bundleId.toLowerCase()) ? 105 : 40;
        const chrome = win.height > 0 ? chromePt / win.height : 0.05;
        if (b.box.y + b.box.h < chrome) return false;
        // Status bars along the bottom edge.
        if (b.box.y > 0.965 && b.text.split(/\s+/).length <= 6) return false;
      }
      if (this.opts.engine === "lines") {
        // Per-line confidence is reliable for this engine; very low means garbled.
        if (b.confidence < this.opts.minConfidence) return false;
        // Lines cut off by the top/bottom edge read as garbage fragments.
        if (b.box.y < 0.003 || b.box.y + b.box.h > 0.997) return false;
      }
      return true;
    });
    stats.noise += blocks.length - usable.length;
    if (this.opts.engine === "lines") usable = groupLines(usable);

    const paragraphs: string[] = [];
    const thisCapture = new Set<string>();
    for (const block of usable) {
      const lines = block.text
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      stats.linesIn += lines.length;
      const clean = lines.filter((l) => !isNoiseLine(l));
      stats.noise += lines.length - clean.length;
      if (clean.length === 0) continue;

      const isNew = clean.map((l) => !this.hasSeen(l) && !thisCapture.has(lineKey(l)));
      const newCount = isNew.filter(Boolean).length;
      // Mostly new paragraph: keep it whole so it still reads naturally.
      // Mostly old (e.g. the page scrolled a bit): keep only the new lines.
      const keep = newCount === 0 ? [] : newCount / clean.length >= 0.5 ? clean : clean.filter((_, i) => isNew[i]);
      stats.duplicate += clean.length - keep.length;
      for (const l of clean) {
        thisCapture.add(lineKey(l));
        this.remember(l);
      }
      if (keep.length) {
        paragraphs.push(keep.join("\n"));
        stats.kept += keep.length;
      }
    }
    return { paragraphs, stats };
  }

  private hasSeen(line: string): boolean {
    const key = lineKey(line);
    if (key.length === 0) return true;
    if (this.exact.has(key)) return true;
    if (key.length < 8) return false; // short lines: exact match only
    const grams = trigrams(key);
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const s = this.recent[i];
      if (Math.abs(s.key.length - key.length) > key.length * 0.25) continue;
      // Cheap filter first, then the exact edit-distance check.
      if (jaccard(grams, s.grams) >= 0.3 && similarKeys(key, s.key)) return true;
    }
    return false;
  }

  private remember(line: string) {
    const key = lineKey(line);
    if (!key || this.exact.has(key)) return;
    this.exact.add(key);
    if (key.length >= 8) {
      this.recent.push({ key, grams: trigrams(key) });
      if (this.recent.length > this.maxRecent) this.recent.shift();
    }
  }
}
