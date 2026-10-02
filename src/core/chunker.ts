// Groups captured text into chunks: passages of roughly a paragraph or a few, all from one window.
// A single capture after a small scroll may add just one new line, so we collect text from
// consecutive captures of the same window and cut a chunk once there's enough of it.
import type { TranscriptEntry } from "./transcript.ts";

export type NewChunk = { text: string; sourceApp: string; sourceTitle: string; capturedAt: string };

export type ChunkerOptions = {
  targetChars: number; // cut a chunk once the buffer reaches this size…
  maxChars: number; // …and never let one grow past this
  maxAgeMs: number; // flush text that has waited this long, even if short
};

export const DEFAULT_CHUNKING: ChunkerOptions = { targetChars: 700, maxChars: 1400, maxAgeMs: 60_000 };

export class Chunker {
  private paragraphs: string[] = [];
  private source: { app: string; title: string } | null = null;
  private startedAt = "";
  private emit: (chunk: NewChunk) => void;
  private opts: ChunkerOptions;

  constructor(emit: (chunk: NewChunk) => void, opts: ChunkerOptions = DEFAULT_CHUNKING) {
    this.emit = emit;
    this.opts = opts;
  }

  add(entry: TranscriptEntry) {
    const sameSource = this.source?.app === entry.app && this.source?.title === entry.title;
    if (!sameSource) this.flush();
    if (this.paragraphs.length === 0) {
      this.source = { app: entry.app, title: entry.title };
      this.startedAt = entry.capturedAt;
    }
    for (const p of splitLong(entry.text.split(/\n{2,}/).filter((p) => p.trim()), this.opts.maxChars)) {
      if (this.size() + p.length > this.opts.maxChars) this.flush(entry);
      this.paragraphs.push(p);
      if (this.size() >= this.opts.targetChars) this.flush(entry);
    }
  }

  /** Call regularly: emits text that has been waiting longer than maxAgeMs. */
  flushIfStale(now = Date.now()) {
    if (this.paragraphs.length && now - Date.parse(this.startedAt) >= this.opts.maxAgeMs) this.flush();
  }

  flush(next?: TranscriptEntry) {
    if (this.paragraphs.length && this.source) {
      this.emit({
        text: this.paragraphs.join("\n\n"),
        sourceApp: this.source.app,
        sourceTitle: this.source.title,
        capturedAt: this.startedAt,
      });
    }
    this.paragraphs = [];
    // Text after a mid-entry cut belongs to the same window and starts now.
    if (next) this.startedAt = next.capturedAt;
    else this.source = null;
  }

  private size() {
    return this.paragraphs.reduce((n, p) => n + p.length + 2, 0);
  }
}

/** Splits any paragraph longer than `max` at line breaks (or, failing that, at spaces). */
function splitLong(paragraphs: string[], max: number): string[] {
  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= max) {
      out.push(p);
      continue;
    }
    let cur = "";
    for (const piece of p.includes("\n") ? p.split("\n") : p.split(" ")) {
      const sep = p.includes("\n") ? "\n" : " ";
      if (cur && cur.length + piece.length + 1 > max) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? cur + sep + piece : piece;
    }
    if (cur) out.push(cur);
  }
  return out;
}
