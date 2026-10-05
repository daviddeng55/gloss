// Notices when you might be stuck, from what you're looking at (no AI involved):
//   - you keep coming back to the same page (3+ returns within 10 minutes), or
//   - the screen hasn't changed for a long time (6+ minutes on one part).
// It only ever *offers* help, at most once per page and once every 15 minutes.

export type ConfusionOptions = { revisits: number; revisitWindowMs: number; stuckMs: number; cooldownMs: number };
export const DEFAULT_CONFUSION: ConfusionOptions = {
  revisits: 3,
  revisitWindowMs: 10 * 60_000,
  stuckMs: 6 * 60_000,
  cooldownMs: 15 * 60_000,
};

export class ConfusionDetector {
  private opts: ConfusionOptions;
  private current = "";
  private unchangedSince = 0;
  private returns = new Map<string, number[]>(); // page -> times you came back to it
  private seen = new Set<string>();
  private lastHintAt = -Infinity;
  private hinted = new Set<string>();

  constructor(opts: ConfusionOptions = DEFAULT_CONFUSION) {
    this.opts = opts;
  }

  /** Call once per capture check. Returns a gentle offer of help, or null. */
  observe(o: { at: number; page: string; title: string; changed: boolean }): string | null {
    if (o.page !== this.current) {
      if (this.seen.has(o.page)) {
        const times = [...(this.returns.get(o.page) ?? []), o.at].filter((t) => o.at - t <= this.opts.revisitWindowMs);
        this.returns.set(o.page, times);
        if (times.length >= this.opts.revisits) {
          return this.offer(o.at, o.page, `You keep coming back to "${shorten(o.title)}". Stuck on something? Circle it and ask.`);
        }
      }
      this.seen.add(o.page);
      this.current = o.page;
      this.unchangedSince = o.at;
      return null;
    }
    if (o.changed) {
      this.unchangedSince = o.at;
      return null;
    }
    if (o.at - this.unchangedSince >= this.opts.stuckMs) {
      return this.offer(o.at, `${o.page}|stuck|${this.unchangedSince}`, `You've been on the same part of "${shorten(o.title)}" for a while. Want a hint? Circle it and ask.`);
    }
    return null;
  }

  private offer(at: number, key: string, text: string): string | null {
    if (this.hinted.has(key) || at - this.lastHintAt < this.opts.cooldownMs) return null;
    this.hinted.add(key);
    this.lastHintAt = at;
    return text;
  }
}

function shorten(title: string) {
  const t = title.replace(/\s*[🔊🔇]\s*$/u, "").trim() || "this page";
  return t.length > 50 ? t.slice(0, 47) + "…" : t;
}
