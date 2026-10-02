// The capture loop shared by the terminal command and the menu bar app:
// every few seconds, find the window you're working in, skip it if it's private, capture it,
// read the text if it changed, clean it, fix math symbols, redact, and hand back an entry.
import { setTimeout as sleep } from "node:timers/promises";
import { TextCleaner } from "./clean.ts";
import type { VisionHelper } from "./helper.ts";
import { fixMath } from "./mathfix.ts";
import { blockedReason, pickFrontWindow, type NeverRecord } from "./privacy.ts";
import { redact } from "./redact.ts";
import type { TranscriptEntry } from "./transcript.ts";

export type CaptureSettings = {
  intervalMs: number;
  mode: "window" | "display";
  engine: "document" | "lines";
  languageCorrection: boolean;
  threshold: number; // fraction of the image that must change before re-reading
};

export const DEFAULT_SETTINGS: CaptureSettings = {
  intervalMs: 5000,
  mode: "window",
  engine: "document",
  languageCorrection: false,
  threshold: 0.02,
};

export type CaptureStats = {
  ticks: number;
  unchanged: number;
  neverRecord: number;
  changedMidCapture: number;
  readOk: number;
  errors: number;
  ocrMsTotal: number;
  linesIn: number;
  noise: number;
  duplicate: number;
  kept: number;
  redactions: number;
  mathFixes: number;
};

export class CaptureLoop {
  readonly stats: CaptureStats = {
    ticks: 0, unchanged: 0, neverRecord: 0, changedMidCapture: 0, readOk: 0, errors: 0,
    ocrMsTotal: 0, linesIn: 0, noise: 0, duplicate: 0, kept: 0, redactions: 0, mathFixes: 0,
  };
  private state: "idle" | "running" | "paused" | "stopped" = "idle";
  private lastSource = "";
  private activeBefore = 0; // ms of active (unpaused) time before the current run stretch
  private runningSince = 0;
  private cleaner: TextCleaner;
  private opts: {
    helper: VisionHelper;
    neverRecord: NeverRecord;
    projectName: string;
    ownPids?: number[]; // windows of these processes (e.g. this app's own windows) are never captured
    settings: CaptureSettings;
    onEntry: (entry: TranscriptEntry) => void;
    onLog?: (line: string) => void;
  };

  constructor(opts: CaptureLoop["opts"]) {
    this.opts = opts;
    this.cleaner = new TextCleaner({ engine: opts.settings.engine, mode: opts.settings.mode, minConfidence: 0.35 });
  }

  get status() {
    return this.state;
  }

  /** Study time so far, not counting pauses. */
  get activeMs(): number {
    return this.activeBefore + (this.state === "running" ? Date.now() - this.runningSince : 0);
  }

  /** Runs until stop() is called. */
  async run(): Promise<void> {
    this.state = "running";
    this.runningSince = Date.now();
    // (Reading `status` rather than `state` because pause()/stop() change it from outside this loop.)
    while (this.status !== "stopped") {
      if (this.status === "paused") {
        await sleep(250);
        continue;
      }
      const tickStart = Date.now();
      await this.tick();
      // Sleep in short steps so pause/stop take effect promptly.
      while (this.status === "running" && Date.now() - tickStart < this.opts.settings.intervalMs) await sleep(250);
    }
  }

  pause() {
    if (this.state !== "running") return;
    this.activeBefore = this.activeMs;
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused") return;
    this.runningSince = Date.now();
    this.lastSource = ""; // read the screen fresh after a pause
    this.state = "running";
  }

  stop() {
    if (this.state === "stopped") return;
    this.activeBefore = this.activeMs;
    this.state = "stopped";
  }

  private log(line: string) {
    this.opts.onLog?.(`${new Date().toLocaleTimeString()}  ${line}`);
  }

  private reasonToSkip(w: Parameters<typeof blockedReason>[0]): string | null {
    if (this.opts.ownPids?.includes(w.pid)) return "this app's own window";
    return blockedReason(w, this.opts.neverRecord, this.opts.projectName);
  }

  private async tick() {
    const { helper, settings } = this.opts;
    const stats = this.stats;
    stats.ticks++;
    try {
      const windows = await helper.windows();
      const front = pickFrontWindow(windows);
      const reason = front ? this.reasonToSkip(front) : "no window on screen";
      if (!front || reason) {
        stats.neverRecord++;
        this.lastSource = "";
        this.log(`skipped: ${reason}`);
        return;
      }
      // Force a fresh read whenever the app or window changes.
      const source = `${front.bundleId}|${front.title}`;
      // Whole-display mode also hides any other window that must not be recorded.
      const excludeWindowIds =
        settings.mode === "display" ? windows.filter((w) => this.reasonToSkip(w)).map((w) => w.windowId) : [];
      const res = await helper.capture({
        mode: settings.mode,
        windowId: front.windowId,
        excludeWindowIds,
        threshold: settings.threshold,
        engine: settings.engine,
        languageCorrection: settings.languageCorrection,
        force: source !== this.lastSource,
      });
      this.lastSource = source;
      if (this.status !== "running") return; // paused/ended while capturing: drop it
      const label = `${front.app} — ${front.title || "(untitled)"}`;
      if (res.skipped) {
        stats.unchanged++;
        this.log(`unchanged (${(res.changeRatio * 100).toFixed(1)}% different)  ${label}`);
        return;
      }
      // Check the window again: if the tab or window changed while capturing (say, to Gmail), the
      // image may not match the title we checked, so throw it away and read again next time.
      const after = (await helper.windows()).find((w) => w.windowId === front.windowId);
      if (!after || after.title !== front.title) {
        stats.changedMidCapture++;
        this.lastSource = "";
        this.log("discarded: window changed while capturing");
        return;
      }
      stats.readOk++;
      stats.ocrMsTotal += res.ms ?? 0;
      const { paragraphs, stats: c } = this.cleaner.clean(res.blocks ?? [], front);
      stats.linesIn += c.linesIn;
      stats.noise += c.noise;
      stats.duplicate += c.duplicate;
      stats.kept += c.kept;
      if (paragraphs.length) {
        const fixed = fixMath(paragraphs.join("\n\n"));
        stats.mathFixes += fixed.count;
        const red = redact(fixed.text);
        stats.redactions += red.count;
        this.opts.onEntry({ capturedAt: new Date().toISOString(), app: front.app, title: front.title, text: red.text });
      }
      this.log(`read ${label}: ${c.linesIn} lines → kept ${c.kept} new, ${c.duplicate} repeated, ${c.noise} noise  (${res.ms} ms)`);
    } catch (err) {
      stats.errors++;
      this.log(`error: ${(err as Error).message}`);
    }
  }
}

/** Human-readable stats table rows, shared by the terminal transcript and the app. */
export function statsRows(s: CaptureStats, activeMs: number): Record<string, string | number> {
  return {
    "Study time": `${(activeMs / 60_000).toFixed(1)} min`,
    "Capture checks": s.ticks,
    "Read (screen changed)": s.readOk,
    "Skipped — unchanged": s.unchanged,
    "Skipped — private or own windows": s.neverRecord,
    "Discarded — window changed mid-capture": s.changedMidCapture,
    Errors: s.errors,
    "Average read time": s.readOk ? `${Math.round(s.ocrMsTotal / s.readOk)} ms` : "—",
    "Lines recognised": s.linesIn,
    "Lines kept": s.kept,
    "Lines dropped as repeats": s.duplicate,
    "Lines dropped as noise": s.noise,
    "Math symbols fixed (∈ ℕ ∀ …)": s.mathFixes,
    Redactions: s.redactions,
  };
}
